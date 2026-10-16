# Reducción de una red de tiendas con análisis geoespacial

Práctica de la Unidad 5 de Ciencia de Datos en Marketing (7.º semestre).

## Contexto

Una cadena tiene cerca de 6,000 tiendas repartidas en el norte del país y en la península de Yucatán. En
varias ciudades hay tiendas muy cerca unas de otras, así que la pregunta del ejercicio es: si tuviéramos que
reducir la red, ¿qué tiendas conviene conservar para no perder demasiado volumen y que siga habiendo una
tienda cerca de donde estaban las demás?

La idea fue armar algo que se pudiera explicar en clase: un mapa donde se vea qué tienda se queda, cuál sería
candidata a cierre y por qué, y una tabla para comparar varios escenarios. No es una recomendación final de
cierres, es un ejercicio exploratorio.

Puedes ver el resultado abriendo `index.html` en el navegador (no necesita servidor).

## Cómo lo resolvimos

Primero revisamos la calidad del archivo de tiendas. Había registros sin coordenadas, una latitud imposible
(28,841,225), una longitud en cero y varios puntos que, aunque tenían coordenadas válidas, caían en el mar o
fuera del país. Esos registros no se corrigieron a mano: se dejaron fuera del cálculo y aparecen en una
sección de revisión dentro del reporte, con el motivo de cada uno.

Después hicimos un cruce espacial con los límites municipales del INEGI para saber en qué estado y municipio
está cada tienda. Ojo: la columna "Region SIX" del archivo es una región comercial, no el estado.

Para decidir qué tiendas se conservan usamos una regla sencilla:

1. Ordenamos las tiendas de mayor a menor volumen.
2. Vamos una por una. Si no hay ninguna tienda ya conservada dentro del radio, se conserva. Si sí la hay,
   se marca como candidata a cierre.
3. Al final, cada candidata se asigna a la tienda conservada más cercana.

Probamos tres radios: 500 m, 1 km y 2 km. Las distancias se calcularon con la fórmula de haversine, que mide
la distancia en línea recta sobre la superficie de la Tierra. Es un método voraz: es fácil de seguir, pero no
garantiza la mejor solución posible.

También comparamos contra otra alternativa: quedarnos con el mismo número de tiendas, pero eligiendo solo
las de mayor volumen sin fijarnos en la ubicación. La diferencia entre ambas es lo que "cuesta" mantener
tiendas cerca de la red actual.

## Resultados

De 5,998 registros, 5,972 entraron al análisis y 26 se quedaron fuera (0.68% del volumen total).

| Radio | Tiendas que se quedan | Candidatas a cierre | Reducción | Volumen que se conserva | Si solo eligiéramos por volumen |
|---|---|---|---|---|---|
| Sin reducción | 5,972 | 0 | 0% | 100% | 100% |
| 500 m | 3,678 | 2,294 | 38.4% | 72.4% | 81.3% |
| 1 km | 2,228 | 3,744 | 62.7% | 49.7% | 60.4% |
| 2 km | 1,338 | 4,634 | 77.6% | 32.7% | 43.4% |

Los porcentajes de volumen son sobre el volumen de las 5,972 tiendas analizadas. Con un radio de 500 m se
reduce más de un tercio de la red y se conserva alrededor de 72% del volumen. Elegir solo por volumen daría
unos 9 a 11 puntos más, pero sin asegurar que quede una tienda cerca de las que se cierran.

No elegimos un escenario "ganador". Depende de cuánto volumen esté dispuesta a perder la empresa y de qué
tan lejos considere aceptable que quede la tienda más cercana.

## Qué hay que tener en cuenta

- El volumen conservado es la suma del volumen histórico de las tiendas que se quedan. No es una predicción
  de ventas, ni supone que los clientes de una tienda cerrada se van a ir a la más cercana.
- "Cercanía" aquí significa distancia a las ubicaciones actuales de las tiendas, no cobertura de población
  ni de clientes. Y es distancia en línea recta, no por calles.
- En 1 km y 2 km hay un par de tiendas que quedan asignadas a otra de un estado vecino (Sonora y Baja
  California, por San Luis Río Colorado). Se permite porque cumplen el radio, pero el reporte lo señala.
- El mapa base necesita internet. Sin conexión, el resto del reporte sigue funcionando.

## Estructura del proyecto

```
├── index.html               reporte interactivo
├── src/
│   ├── generar_proyecto.py  análisis completo y generación del HTML
│   └── plantilla/           HTML, CSS y JavaScript del reporte (y Leaflet)
├── datos/
│   └── coordenadas_tiendas.csv
├── salidas/                 resultados en CSV
└── requirements.txt
```

En `salidas/` están la clasificación de cada tienda por escenario, el resumen de escenarios, los registros
que necesitan revisión y las comprobaciones que hace el script (por ejemplo, que ninguna tienda se pierda
en el camino y que toda candidata tenga una tienda conservada dentro del radio).

## Cómo volver a generarlo

```bash
pip install -r requirements.txt
python src/generar_proyecto.py
```

Los límites municipales del INEGI (un GeoJSON por estado, unos 165 MB) no están en el repositorio por su
tamaño. Para regenerar el análisis hay que ponerlos en `datos/contornos/`. Si quieres probar otros radios:

```bash
python src/generar_proyecto.py --radios 300 750 1500
```

Herramientas: Python (pandas, GeoPandas, scikit-learn) para el análisis y Leaflet para el mapa.
