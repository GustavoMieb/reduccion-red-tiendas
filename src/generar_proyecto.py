"""
Genera el análisis de reducción de la red de tiendas y el archivo index.html.

Flujo:
  1. Lee coordenadas_tiendas.csv (sin modificarlo) y normaliza encabezados.
  2. Revisa calidad: faltantes, IDs duplicados, volumen no numérico,
     coordenadas inválidas, en cero o sospechosas.
  3. Carga automáticamente los contornos (JSON/GeoJSON) de la carpeta indicada,
     verifica su CRS y hace la unión espacial tienda -> municipio/estado.
  4. Ejecuta la heurística voraz por volumen para cada radio.
  5. Comprueba reconciliaciones y escribe salidas CSV + index.html autocontenido.

Uso:
  python src/generar_proyecto.py
  python src/generar_proyecto.py --contornos "datos/contornos" --radios 500 1000 2000
"""

import argparse
import json
import sys
import time
import warnings
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point, mapping
from sklearn.neighbors import BallTree

# Raíz del proyecto (este script vive en src/)
BASE_DIR = Path(__file__).resolve().parent.parent
SRC_DIR = Path(__file__).resolve().parent
EARTH_RADIUS_M = 6371008.8  # radio medio terrestre (IUGG), en metros

# Proyección cónica conforme de Lambert para México (INEGI, ITRF2008).
# Se usa SOLO para medir qué tan lejos queda un punto del contorno más cercano
# (dato de referencia para la revisión), nunca para la heurística de cierre.
MEXICO_LCC = "EPSG:6372"

# Rango aproximado del territorio mexicano (con margen) para marcar coordenadas sospechosas.
MEXICO_BBOX = {"lonMin": -118.6, "lonMax": -86.5, "latMin": 14.4, "latMax": 32.8}

# Distancia máxima a un contorno para considerar que un punto fuera de polígonos
# es un problema de precisión costera/fronteriza (se conserva como elegible).
OUTSIDE_TOLERANCE_M = 2000

# Primeros dos dígitos del código postal -> clave de entidad (CVE_ENT) según SEPOMEX.
CP_PREFIX_TO_CVE = {}
for prefixes, cve in [
    (range(1, 17), "09"), ([20], "01"), ([21, 22], "02"), ([23], "03"), ([24], "04"),
    ([25, 26, 27], "05"), ([28], "06"), ([29, 30], "07"), ([31, 32, 33], "08"),
    ([34, 35], "10"), ([36, 37, 38], "11"), ([39, 40, 41], "12"), ([42, 43], "13"),
    (range(44, 50), "14"), (range(50, 58), "15"), (range(58, 62), "16"), ([62], "17"),
    ([63], "18"), (range(64, 68), "19"), (range(68, 72), "20"), (range(72, 76), "21"),
    ([76], "22"), ([77], "23"), ([78, 79], "24"), ([80, 81, 82], "25"), ([83, 84, 85], "26"),
    ([86], "27"), ([87, 88, 89], "28"), ([90], "29"), (range(91, 97), "30"), ([97], "31"),
    ([98, 99], "32"),
]:
    for p in prefixes:
        CP_PREFIX_TO_CVE[f"{p:02d}"] = cve

UNASSIGNED = "Sin asignar"


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

def haversineMeters(lat1, lon1, lat2, lon2):
    """Distancia ortodrómica (línea recta sobre la esfera) en metros. Acepta arreglos."""
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def scenarioLabel(radiusM):
    return f"{radiusM / 1000:g} km" if radiusM >= 1000 else f"{radiusM:g} m"


START = time.time()


def log(msg):
    print(f"[{time.time() - START:6.1f}s] {msg}", flush=True)


# ---------------------------------------------------------------------------
# 1. Lectura y calidad de datos
# ---------------------------------------------------------------------------

def loadStores(csvPath):
    """Lee el CSV como texto, normaliza encabezados y convierte columnas numéricas."""
    raw = pd.read_csv(csvPath, dtype=str, encoding="utf-8-sig", keep_default_na=False)
    raw.columns = [c.strip() for c in raw.columns]
    rename = {"Region SIX": "region", "ID": "id", "Longitud": "lonText", "Latitud": "latText",
              "CP": "cp", "Volumen": "volText"}
    missingCols = [c for c in rename if c not in raw.columns]
    if missingCols:
        sys.exit(f"Faltan columnas en el CSV: {missingCols}")
    df = raw.rename(columns=rename)[list(rename.values())].copy()
    for col in df.columns:
        df[col] = df[col].str.strip()
    df["rowNumber"] = np.arange(2, len(df) + 2)  # número de línea en el archivo (encabezado = 1)
    df["lon"] = pd.to_numeric(df["lonText"].replace("", np.nan), errors="coerce")
    df["lat"] = pd.to_numeric(df["latText"].replace("", np.nan), errors="coerce")
    df["volume"] = pd.to_numeric(df["volText"].replace("", np.nan), errors="coerce")
    return df


def checkQuality(df):
    """Agrega columnas de problemas. 'exclusionIssues' impiden participar en la heurística;
    'warningIssues' son observaciones que no excluyen el registro."""
    exclusion = [[] for _ in range(len(df))]
    warning = [[] for _ in range(len(df))]

    def add(target, mask, text):
        for i in np.flatnonzero(mask.to_numpy()):
            target[i].append(text if isinstance(text, str) else text(df.iloc[i]))

    # Identificadores
    add(exclusion, df["id"] == "", "ID vacío")
    dupMask = (df["id"] != "") & df["id"].duplicated(keep=False)
    add(exclusion, dupMask, "ID duplicado")

    # Volumen
    add(exclusion, df["volText"] == "", "Volumen faltante")
    add(exclusion, (df["volText"] != "") & df["volume"].isna(), "Volumen no numérico")
    add(exclusion, df["volume"] < 0, "Volumen negativo")
    add(warning, df["volume"] == 0, "Volumen igual a cero")

    # Coordenadas
    lat, lon = df["lat"], df["lon"]
    noCoord = (df["latText"] == "") | (df["lonText"] == "")
    add(exclusion, noCoord, "Sin coordenadas")
    nonNumeric = ~noCoord & (lat.isna() | lon.isna())
    add(exclusion, nonNumeric, "Coordenada no numérica")
    numeric = lat.notna() & lon.notna()
    outWorld = numeric & ((lat.abs() > 90) | (lon.abs() > 180))
    add(exclusion, outWorld, lambda r: f"Coordenada fuera del rango mundial (lat {r.latText}, lon {r.lonText})")
    zero = numeric & ~outWorld & ((lat == 0) | (lon == 0))
    add(exclusion, zero, lambda r: f"Coordenada en cero (lat {r.latText}, lon {r.lonText})")
    plausible = numeric & ~outWorld & ~zero
    outMexico = plausible & ~(lat.between(MEXICO_BBOX["latMin"], MEXICO_BBOX["latMax"])
                              & lon.between(MEXICO_BBOX["lonMin"], MEXICO_BBOX["lonMax"]))
    add(exclusion, outMexico, "Coordenada fuera del rango geográfico de México")

    # Código postal (se conserva como texto, no se corrige)
    badCp = ~df["cp"].str.fullmatch(r"\d{5}")
    add(warning, badCp, lambda r: f"CP con formato no estándar ('{r.cp}'); posible cero inicial perdido")

    df["exclusionIssues"] = exclusion
    df["warningIssues"] = warning
    df["hasMapCoords"] = (plausible & ~outMexico).to_numpy()
    return df


# ---------------------------------------------------------------------------
# 2. Contornos y unión espacial
# ---------------------------------------------------------------------------

def loadContours(folder):
    """Busca recursivamente archivos .json/.geojson con polígonos municipales.
    Devuelve un GeoDataFrame en EPSG:4326 y un registro de lo cargado/omitido."""
    files = sorted([p for p in folder.rglob("*") if p.suffix.lower() in (".json", ".geojson")])
    layers, report = [], []
    for path in files:
        try:
            gdf = gpd.read_file(path)
        except Exception as exc:  # archivo no geográfico o dañado
            report.append({"archivo": path.name, "estado": "omitido", "detalle": f"no legible: {exc}"})
            continue
        needed = {"NOM_ENT", "NOMGEO", "CVE_ENT", "CVE_MUN"}
        if not needed.issubset(gdf.columns) or not gdf.geom_type.isin(["Polygon", "MultiPolygon"]).all():
            report.append({"archivo": path.name, "estado": "omitido",
                           "detalle": "sin polígonos o sin propiedades NOM_ENT/NOMGEO/CVE_ENT/CVE_MUN"})
            continue
        crsText = gdf.crs.to_string() if gdf.crs else "sin CRS"
        if gdf.crs is None:
            # Las coordenadas en grados dentro del rango de México se asumen WGS84 y se documenta.
            gdf = gdf.set_crs("EPSG:4326")
            crsText += " (se asume EPSG:4326)"
        elif gdf.crs.to_epsg() != 4326:
            gdf = gdf.to_crs("EPSG:4326")
            crsText += " -> transformado a EPSG:4326"
        invalid = int((~gdf.is_valid).sum())
        if invalid:
            gdf["geometry"] = gdf.geometry.make_valid()
        gdf["sourceFile"] = path.name
        layers.append(gdf[["CVE_ENT", "CVE_MUN", "NOM_ENT", "NOMGEO", "sourceFile", "geometry"]])
        report.append({"archivo": path.name, "estado": "cargado", "detalle":
                       f"{gdf['NOM_ENT'].iloc[0]} · {len(gdf)} municipios · CRS {crsText}"
                       + (f" · {invalid} geometrías reparadas" if invalid else "")})
    if not layers:
        return gpd.GeoDataFrame(columns=["CVE_ENT", "CVE_MUN", "NOM_ENT", "NOMGEO", "geometry"],
                                geometry="geometry", crs="EPSG:4326"), report
    munis = gpd.GeoDataFrame(pd.concat(layers, ignore_index=True), crs="EPSG:4326")
    # Si un estado viene repetido en dos archivos se conserva el primero y se avisa.
    dupStates = munis.groupby("CVE_ENT")["sourceFile"].nunique()
    for cve in dupStates[dupStates > 1].index:
        keep = munis.loc[munis["CVE_ENT"] == cve, "sourceFile"].iloc[0]
        report.append({"archivo": "(varios)", "estado": "aviso",
                       "detalle": f"Entidad {cve} en varios archivos; se usa {keep}"})
        munis = munis[(munis["CVE_ENT"] != cve) | (munis["sourceFile"] == keep)]
    munis["CVEGEO"] = munis["CVE_ENT"] + munis["CVE_MUN"]
    munis = munis.drop_duplicates("CVEGEO").reset_index(drop=True)
    return munis, report


def spatialJoin(df, munis):
    """Asigna estado y municipio por punto-en-polígono con las geometrías originales.
    Reglas explícitas:
      - Se usa 'intersects' para no perder puntos exactamente sobre un límite.
      - Si hay varias coincidencias se prefiere el polígono que contiene el punto en su
        interior; si sigue habiendo empate (punto sobre límite compartido o polígonos
        superpuestos) se elige la menor clave CVEGEO y se marca para revisión.
      - Un punto fuera de todos los polígonos queda 'Sin asignar'. Solo como referencia se
        informa el contorno más cercano y su distancia; no se usa para asignar."""
    df["stateName"] = UNASSIGNED
    df["stateCve"] = ""
    df["muniName"] = UNASSIGNED
    df["muniCve"] = ""
    df["joinNote"] = ""
    df["nearestRef"] = ""
    df["nearestDistM"] = np.nan

    mapped = df[df["hasMapCoords"]]
    if munis.empty or mapped.empty:
        return df
    points = gpd.GeoDataFrame(mapped[["id"]].copy(), geometry=gpd.points_from_xy(mapped["lon"], mapped["lat"]),
                              crs="EPSG:4326")
    hits = gpd.sjoin(points, munis, how="left", predicate="intersects")
    loadedCves = set(munis["CVE_ENT"])

    for idx, group in hits.groupby(level=0, sort=False):
        group = group.dropna(subset=["index_right"])
        if group.empty:
            continue
        note = ""
        if len(group) > 1:
            pt = points.geometry.loc[idx]
            interior = group[[munis.geometry.iloc[int(j)].contains(pt) for j in group["index_right"]]]
            options = ", ".join(f"{r.NOMGEO} ({r.NOM_ENT})" for r in group.itertuples())
            if len(interior) == 1:
                group = interior
                note = f"Coincidencia múltiple ({options}); se eligió el polígono que lo contiene en su interior"
            else:
                pool = interior if len(interior) > 1 else group
                group = pool.sort_values("CVEGEO").iloc[[0]]
                kind = "polígonos superpuestos" if len(interior) > 1 else "punto sobre un límite"
                note = f"Coincidencia múltiple por {kind} ({options}); se eligió la menor clave CVEGEO"
        row = group.iloc[0]
        df.loc[idx, ["stateName", "stateCve", "muniName", "muniCve", "joinNote"]] = [
            row["NOM_ENT"], row["CVE_ENT"], row["NOMGEO"], row["CVEGEO"], note]

    # Referencia para puntos fuera de todos los contornos
    outside = df.index[df["hasMapCoords"] & (df["stateName"] == UNASSIGNED)]
    if len(outside):
        outPts = points.loc[outside].to_crs(MEXICO_LCC)
        near = gpd.sjoin_nearest(outPts, munis.to_crs(MEXICO_LCC), how="left", distance_col="distM")
        near = near[~near.index.duplicated(keep="first")]
        for idx, r in near.iterrows():
            df.loc[idx, "nearestRef"] = f"{r['NOMGEO']} ({r['NOM_ENT']})"
            df.loc[idx, "nearestDistM"] = r["distM"]

    df["cpCve"] = df["cp"].str[:2].map(CP_PREFIX_TO_CVE).fillna("")
    for idx in outside:
        cpCve = df.at[idx, "cpCve"]
        dist = df.at[idx, "nearestDistM"]
        ref = df.at[idx, "nearestRef"]
        if cpCve and cpCve not in loadedCves:
            df.at[idx, "warningIssues"] = df.at[idx, "warningIssues"] + [
                f"Sin estado asignado: no se cargó el contorno de la entidad que sugiere su CP ({cpCve})"]
            df.at[idx, "coverageGap"] = True
        elif dist <= OUTSIDE_TOLERANCE_M:
            df.at[idx, "warningIssues"] = df.at[idx, "warningIssues"] + [
                f"Fuera de los contornos por {dist:,.0f} m (posible costa o límite); contorno más cercano: {ref}. "
                "No se asignó por cercanía"]
        else:
            df.at[idx, "exclusionIssues"] = df.at[idx, "exclusionIssues"] + [
                f"Ubicación sospechosa: fuera de los contornos de México a {dist / 1000:,.1f} km "
                f"(más cercano: {ref})"]
    return df


def crossChecks(df, munis):
    """Observaciones de consistencia que no excluyen: CP vs. estado del cruce espacial,
    región SIX atípica para el estado y coordenadas repetidas."""
    nameByCve = munis.drop_duplicates("CVE_ENT").set_index("CVE_ENT")["NOM_ENT"].to_dict()
    assigned = df["stateCve"] != ""
    # Solo se compara con CP de 5 dígitos; un CP mal formado ya se reporta aparte.
    validCp = df["cp"].str.fullmatch(r"\d{5}")
    mismatch = assigned & validCp & (df["cpCve"] != "") & (df["cpCve"] != df["stateCve"])
    for idx in df.index[mismatch]:
        cpState = nameByCve.get(df.at[idx, "cpCve"], f"entidad {df.at[idx, 'cpCve']}")
        df.at[idx, "warningIssues"] = df.at[idx, "warningIssues"] + [
            f"CP {df.at[idx, 'cp']} corresponde a {cpState}, pero la coordenada cae en {df.at[idx, 'stateName']}"]

    # Región SIX: se marca si la tienda está en un estado donde su región tiene <2% de las tiendas del estado
    stateRegion = df[assigned].groupby(["stateName", "region"]).size()
    stateTotals = df[assigned].groupby("stateName").size()
    share = (stateRegion / stateTotals.reindex(stateRegion.index.get_level_values(0)).to_numpy())
    rare = set(share[share < 0.02].index)
    for idx in df.index[assigned]:
        key = (df.at[idx, "stateName"], df.at[idx, "region"])
        if key in rare:
            df.at[idx, "warningIssues"] = df.at[idx, "warningIssues"] + [
                f"Región SIX '{key[1]}' atípica en {key[0]} (<2% de las tiendas del estado)"]

    coordKey = df["lat"].round(7).astype(str) + "," + df["lon"].round(7).astype(str)
    repeated = df["hasMapCoords"] & coordKey.duplicated(keep=False)
    for key, grp in df[repeated].groupby(coordKey[repeated]):
        for idx in grp.index:
            others = ", ".join(i for i in grp["id"] if i != df.at[idx, "id"])
            df.at[idx, "warningIssues"] = df.at[idx, "warningIssues"] + [
                f"Coordenada idéntica a otra(s) tienda(s): {others}"]
    return df


# ---------------------------------------------------------------------------
# 3. Heurística voraz
# ---------------------------------------------------------------------------

def greedyScenario(eligible, radiusM):
    """Recorre tiendas por volumen descendente (desempate: ID ascendente).
    Se conserva una tienda si no hay otra ya conservada dentro del radio; si la hay,
    pasa a candidata a cierre. Después cada candidata se asigna a la conservada más cercana."""
    order = eligible.sort_values(["volume", "id"], ascending=[False, True]).index.to_numpy()
    coordsRad = np.radians(eligible.loc[order, ["lat", "lon"]].to_numpy())
    tree = BallTree(coordsRad, metric="haversine")
    neighbors = tree.query_radius(coordsRad, r=radiusM / EARTH_RADIUS_M)

    kept = np.zeros(len(order), dtype=bool)
    for pos in range(len(order)):
        # Una vecina con posición menor ya fue evaluada; si se conservó, esta tienda queda cubierta.
        nb = neighbors[pos]
        kept[pos] = not kept[nb[nb < pos]].any()

    result = pd.DataFrame(index=order)
    result["status"] = np.where(kept, "Conservada", "Candidata a cierre")
    result["rank"] = np.arange(1, len(order) + 1)
    result["assignedId"] = ""
    result["distanceM"] = np.nan
    if (~kept).any():
        keptTree = BallTree(coordsRad[kept], metric="haversine")
        dist, nearest = keptTree.query(coordsRad[~kept], k=1)
        keptIdx = order[kept]
        result.loc[order[~kept], "assignedIdx"] = keptIdx[nearest[:, 0]]
        result.loc[order[~kept], "assignedId"] = eligible.loc[keptIdx[nearest[:, 0]], "id"].to_numpy()
        # Distancia recalculada con haversine explícito (verificación independiente del árbol)
        a = eligible.loc[order[~kept]]
        b = eligible.loc[keptIdx[nearest[:, 0]]]
        result.loc[order[~kept], "distanceM"] = haversineMeters(
            a["lat"].to_numpy(), a["lon"].to_numpy(), b["lat"].to_numpy(), b["lon"].to_numpy())
    return result


def summarize(df, eligible, scenarios, radii):
    totalVolume = df["volume"].sum()
    eligVolume = eligible["volume"].sum()
    nElig = len(eligible)
    sortedVol = eligible["volume"].sort_values(ascending=False).to_numpy()
    rows = [{
        "escenario": "Sin reducción", "radioM": 0, "conservadas": nElig, "candidatas": 0,
        "reduccionPct": 0.0, "volumenConservado": eligVolume, "volumenPctElegible": 100.0,
        "volumenPctTotal": 100 * eligVolume / totalVolume, "volumenTopN": eligVolume,
        "volumenPctTopN": 100.0, "costoCoberturaPp": 0.0, "distMediaM": np.nan, "distMaxM": np.nan,
        "asignacionesEntreEstados": 0, "asignacionesEstadoIndeterminado": 0}]
    for r in radii:
        res = scenarios[r]
        kept = res["status"] == "Conservada"
        nKept = int(kept.sum())
        keptVol = eligible.loc[res.index[kept], "volume"].sum()
        topN = sortedVol[:nKept].sum()
        cand = res[~kept]
        cross = unknown = 0
        if len(cand):
            # Entre estados solo si ambas tiendas tienen estado asignado; si falta alguno, es indeterminado
            a = eligible.loc[cand.index, "stateName"].to_numpy()
            b = eligible.loc[cand["assignedIdx"].astype(int), "stateName"].to_numpy()
            known = (a != UNASSIGNED) & (b != UNASSIGNED)
            cross = int((known & (a != b)).sum())
            unknown = int((~known).sum())
        rows.append({
            "escenario": scenarioLabel(r), "radioM": r, "conservadas": nKept, "candidatas": nElig - nKept,
            "reduccionPct": 100 * (nElig - nKept) / nElig, "volumenConservado": keptVol,
            "volumenPctElegible": 100 * keptVol / eligVolume, "volumenPctTotal": 100 * keptVol / totalVolume,
            "volumenTopN": topN, "volumenPctTopN": 100 * topN / eligVolume,
            "costoCoberturaPp": 100 * (topN - keptVol) / eligVolume,
            "distMediaM": cand["distanceM"].mean() if len(cand) else np.nan,
            "distMaxM": cand["distanceM"].max() if len(cand) else np.nan,
            "asignacionesEntreEstados": cross, "asignacionesEstadoIndeterminado": unknown})
    return pd.DataFrame(rows)


def verify(df, eligible, excluded, scenarios, radii):
    """Comprobaciones de reconciliación. Detiene el proceso si algo no cuadra."""
    checks = []

    def check(cond, text):
        checks.append({"comprobacion": text, "resultado": "OK" if cond else "FALLA"})
        if not cond:
            log(f"  [FALLA] {text}")

    check(len(eligible) + len(excluded) == len(df), "Elegibles + excluidos = total de registros")
    volOk = np.isclose(eligible["volume"].sum() + excluded["volume"].fillna(0).sum(), df["volume"].fillna(0).sum())
    check(volOk, "Volumen elegible + volumen excluido = volumen total")
    for r in radii:
        res = scenarios[r]
        lab = scenarioLabel(r)
        check(set(res.index) == set(eligible.index), f"{lab}: cada tienda elegible tiene exactamente una clasificación")
        kept = res[res["status"] == "Conservada"]
        cand = res[res["status"] != "Conservada"]
        check(len(kept) + len(cand) == len(eligible), f"{lab}: conservadas + candidatas = elegibles")
        volSum = eligible.loc[kept.index, "volume"].sum() + eligible.loc[cand.index, "volume"].sum()
        check(np.isclose(volSum, eligible["volume"].sum()), f"{lab}: volumen conservado + candidatas = volumen elegible")
        check(bool((cand["distanceM"] <= r + 1e-6).all()), f"{lab}: toda candidata tiene una conservada dentro de {lab}")
        check(bool(cand["assignedIdx"].isin(kept.index).all()) if len(cand) else True,
              f"{lab}: toda candidata está asignada a una tienda conservada")
        # Las conservadas deben estar separadas más que el radio entre sí
        k = eligible.loc[kept.index]
        tree = BallTree(np.radians(k[["lat", "lon"]].to_numpy()), metric="haversine")
        cnt = tree.query_radius(np.radians(k[["lat", "lon"]].to_numpy()), r=r / EARTH_RADIUS_M, count_only=True)
        check(bool((cnt == 1).all()), f"{lab}: ninguna pareja de conservadas está dentro de {lab}")
        # Monotonía: un radio mayor no puede conservar más tiendas que la distancia mínima garantiza
    return pd.DataFrame(checks)


# ---------------------------------------------------------------------------
# 4. Geometrías de visualización (simplificadas; las originales se usan solo en la unión)
# ---------------------------------------------------------------------------

def roundCoords(obj, nd=4):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], nd), round(obj[1], nd)]
        return [roundCoords(o, nd) for o in obj]
    return obj


def toFeatureCollection(gdf, props, tolerance, nd):
    feats = []
    for _, row in gdf.iterrows():
        geom = row.geometry.simplify(tolerance, preserve_topology=True)
        if geom.is_empty:
            continue
        g = mapping(geom)
        feats.append({"type": "Feature", "properties": {k: row[k] for k in props},
                      "geometry": {"type": g["type"], "coordinates": roundCoords(g["coordinates"], nd)}})
    return {"type": "FeatureCollection", "features": feats}


def displayGeometries(munis, statesWithStores):
    """Contornos estatales de los 32 archivos y municipales solo de estados con tiendas
    (capa opcional). Se simplifica primero para que el dissolve sea rápido; las pequeñas
    holguras que deja la simplificación se cierran con un buffer mínimo en grados, que
    aquí es aceptable porque solo afecta al dibujo, no al análisis."""
    light = munis[["CVE_ENT", "NOM_ENT", "NOMGEO", "geometry"]].copy()
    light["geometry"] = light.geometry.simplify(0.001, preserve_topology=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        states = light.dissolve(by=["CVE_ENT", "NOM_ENT"], as_index=False)[["CVE_ENT", "NOM_ENT", "geometry"]]
        states["geometry"] = states.geometry.buffer(0.002).buffer(-0.002)
    stateFc = toFeatureCollection(states, ["NOM_ENT"], 0.008, 3)
    muniFc = toFeatureCollection(light[light["NOM_ENT"].isin(statesWithStores)], ["NOM_ENT", "NOMGEO"], 0.003, 3)
    return stateFc, muniFc


# ---------------------------------------------------------------------------
# 5. Construcción del HTML
# ---------------------------------------------------------------------------

def buildPayload(df, eligible, scenarios, radii, summary, contourReport, checks, munisLoaded):
    """Empaqueta los datos en arreglos compactos para incrustarlos en el HTML."""
    states = sorted(s for s in df["stateName"].unique() if s != UNASSIGNED) + [UNASSIGNED]
    stateIndex = {s: i for i, s in enumerate(states)}
    munis = sorted(df["muniName"].unique())
    muniIndex = {m: i for i, m in enumerate(munis)}
    regions = sorted(df["region"].unique())
    regionIndex = {r: i for i, r in enumerate(regions)}

    rowPos = {idx: i for i, idx in enumerate(df.index)}
    stores = []
    for idx, r in df.iterrows():
        stores.append([
            r["id"],
            None if pd.isna(r["lat"]) or not r["hasMapCoords"] else round(float(r["lat"]), 6),
            None if pd.isna(r["lon"]) or not r["hasMapCoords"] else round(float(r["lon"]), 6),
            None if pd.isna(r["volume"]) else round(float(r["volume"]), 6),
            stateIndex[r["stateName"]], muniIndex[r["muniName"]], regionIndex[r["region"]], r["cp"],
            1 if idx in eligible.index else 0,
            r["latText"], r["lonText"],
        ])

    scenarioData = []
    for r in radii:
        res = scenarios[r]
        status = [2] * len(df)  # 0 conservada, 1 candidata, 2 excluida
        assigned = [-1] * len(df)
        dist = [None] * len(df)
        for idx, row in res.iterrows():
            p = rowPos[idx]
            if row["status"] == "Conservada":
                status[p] = 0
            else:
                status[p] = 1
                assigned[p] = rowPos[int(row["assignedIdx"])]
                dist[p] = round(float(row["distanceM"]), 1)
        scenarioData.append({"radiusM": r, "label": scenarioLabel(r), "status": status,
                             "assigned": assigned, "distanceM": dist})

    review = []
    for idx, r in df.iterrows():
        issues = r["exclusionIssues"] + r["warningIssues"] + ([r["joinNote"]] if r["joinNote"] else [])
        if issues:
            review.append({"row": rowPos[idx], "line": int(r["rowNumber"]),
                           "excluded": bool(r["exclusionIssues"]), "issues": issues})

    return {
        "generatedAt": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M"),
        "states": states, "munis": munis, "regions": regions,
        "stores": stores, "scenarios": scenarioData, "review": review,
        "summary": json.loads(summary.to_json(orient="records")),
        "contourReport": contourReport, "checks": checks.to_dict(orient="records"),
        "statesLoaded": munisLoaded,
    }


def buildHtml(payload, stateFc, muniFc, outPath):
    tpl = SRC_DIR / "plantilla"
    html = (tpl / "template.html").read_text(encoding="utf-8")

    def scriptJson(obj):
        # '</' escapado para que ningún texto cierre la etiqueta <script> antes de tiempo
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

    replacements = {
        "/*__LEAFLET_CSS__*/": (tpl / "vendor" / "leaflet.css").read_text(encoding="utf-8"),
        "/*__STYLES__*/": (tpl / "styles.css").read_text(encoding="utf-8"),
        "/*__LEAFLET_JS__*/": (tpl / "vendor" / "leaflet.js").read_text(encoding="utf-8"),
        "/*__APP_JS__*/": (tpl / "app.js").read_text(encoding="utf-8"),
        "__DATA_JSON__": scriptJson(payload),
        "__STATES_GEOJSON__": scriptJson(stateFc),
        "__MUNIS_GEOJSON__": scriptJson(muniFc),
    }
    for key, value in replacements.items():
        if key not in html:
            sys.exit(f"La plantilla no contiene el marcador {key}")
        html = html.replace(key, value)
    outPath.write_text(html, encoding="utf-8")


# ---------------------------------------------------------------------------
# Programa principal
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", default="datos/coordenadas_tiendas.csv")
    parser.add_argument("--contornos", default="datos/contornos", help="carpeta con JSON/GeoJSON por estado")
    parser.add_argument("--radios", type=float, nargs="+", default=[500, 1000, 2000], help="radios en metros")
    parser.add_argument("--salida", default="index.html")
    args = parser.parse_args()
    radii = sorted(int(r) if float(r).is_integer() else r for r in args.radios)

    log("1) Leyendo tiendas y revisando calidad…")
    df = loadStores(BASE_DIR / args.csv)
    df["coverageGap"] = False
    df = checkQuality(df)

    log("2) Cargando contornos y cruzando con tiendas…")
    munis, contourReport = loadContours(BASE_DIR / args.contornos)
    for item in contourReport:
        log(f"   - {item['archivo']}: {item['estado']} · {item['detalle']}")
    df = spatialJoin(df, munis)
    if "cpCve" not in df:
        df["cpCve"] = df["cp"].str[:2].map(CP_PREFIX_TO_CVE).fillna("")
    df = crossChecks(df, munis)

    eligibleMask = df["exclusionIssues"].str.len() == 0
    eligible = df[eligibleMask]
    excluded = df[~eligibleMask]
    log(f"   Registros: {len(df)} · elegibles: {len(eligible)} · excluidos: {len(excluded)}")

    log("3) Ejecutando heurística voraz…")
    scenarios = {r: greedyScenario(eligible, r) for r in radii}
    summary = summarize(df, eligible, scenarios, radii)
    checks = verify(df, eligible, excluded, scenarios, radii)
    if (checks["resultado"] != "OK").any():
        sys.exit("Hay comprobaciones fallidas; revise los mensajes anteriores.")
    log("   Todas las comprobaciones de reconciliación pasaron.")

    log("4) Escribiendo salidas CSV…")
    outDir = BASE_DIR / "salidas"
    outDir.mkdir(exist_ok=True)
    detail = df[["id", "region", "cp", "latText", "lonText", "volume", "stateName", "muniName"]].rename(columns={
        "latText": "latitud", "lonText": "longitud", "volume": "volumen", "stateName": "estado", "muniName": "municipio"})
    detail["elegible"] = np.where(eligibleMask, "Sí", "No")
    for r in radii:
        lab = scenarioLabel(r).replace(" ", "")
        res = scenarios[r]
        detail[f"clasificacion_{lab}"] = res["status"].reindex(df.index).fillna("Excluida")
        detail[f"asignadaA_{lab}"] = res["assignedId"].reindex(df.index).fillna("")
        detail[f"distanciaM_{lab}"] = res["distanceM"].reindex(df.index).round(1)
        assignedState = res["assignedIdx"].reindex(df.index).map(lambda j: df.at[int(j), "stateName"] if pd.notna(j) else "")
        detail[f"entreEstados_{lab}"] = np.select(
            [assignedState == "", (assignedState == UNASSIGNED) | (df["stateName"] == UNASSIGNED), assignedState != df["stateName"]],
            ["", "Indeterminado", "Sí"], "No")
    detail.to_csv(outDir / "tiendas_escenarios.csv", index=False, encoding="utf-8-sig")
    summary.round(4).to_csv(outDir / "resumen_escenarios.csv", index=False, encoding="utf-8-sig")
    reviewRows = df[(df["exclusionIssues"].str.len() > 0) | (df["warningIssues"].str.len() > 0) | (df["joinNote"] != "")]
    pd.DataFrame({
        "lineaArchivo": reviewRows["rowNumber"], "id": reviewRows["id"], "latitud": reviewRows["latText"],
        "longitud": reviewRows["lonText"], "cp": reviewRows["cp"], "volumen": reviewRows["volume"],
        "estado": reviewRows["stateName"], "elegible": np.where(reviewRows["exclusionIssues"].str.len() > 0, "No", "Sí"),
        "problemas": [" | ".join(a + b + ([c] if c else [])) for a, b, c in
                      zip(reviewRows["exclusionIssues"], reviewRows["warningIssues"], reviewRows["joinNote"])],
    }).to_csv(outDir / "registros_revision.csv", index=False, encoding="utf-8-sig")
    checks.to_csv(outDir / "comprobaciones.csv", index=False, encoding="utf-8-sig")

    log("5) Generando geometrías de visualización e index.html…")
    statesWithStores = sorted(s for s in df["stateName"].unique() if s != UNASSIGNED)
    stateFc, muniFc = displayGeometries(munis, statesWithStores)
    payload = buildPayload(df, eligible, scenarios, radii, summary, contourReport, checks,
                           sorted(munis["NOM_ENT"].unique().tolist()))
    outPath = BASE_DIR / args.salida
    buildHtml(payload, stateFc, muniFc, outPath)
    log(f"   {outPath} ({outPath.stat().st_size / 1e6:.1f} MB)")

    log("\nResumen:")
    with pd.option_context("display.width", 200, "display.max_columns", 20):
        log(summary[["escenario", "conservadas", "candidatas", "reduccionPct", "volumenConservado",
                     "volumenPctElegible", "volumenPctTopN", "costoCoberturaPp", "distMaxM",
                     "asignacionesEntreEstados"]].round(2).to_string(index=False))
    log(f"Excluidos: {len(excluded)} registros · volumen {excluded['volume'].sum():,.2f} "
        f"({100 * excluded['volume'].sum() / df['volume'].sum():.2f}% del volumen total)")


if __name__ == "__main__":
    main()
