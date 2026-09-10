"""Build-time SVG conversion; the app only draws cached native vector paths."""
import json
import sys
from xml.etree.ElementTree import Element, SubElement, tostring
from fontTools.svgLib.path import SVGPath
from fontTools.pens.recordingPen import RecordingPen

codes = {"moveTo": 0, "lineTo": 1, "curveTo": 2, "qCurveTo": 3, "closePath": 4}
result = {}
for name, nodes in json.load(sys.stdin).items():
    svg = Element("svg")
    for tag, attrs in nodes:
        SubElement(svg, tag, {k: str(v) for k, v in attrs.items() if k != "key"})
    pen = RecordingPen()
    SVGPath.fromstring(tostring(svg)).draw(pen)
    result[name] = [
        [codes[op], *(round(coordinate, 5) for point in points for coordinate in point)]
        for op, points in pen.value if op != "endPath"
    ]
json.dump(result, sys.stdout, separators=(",", ":"), sort_keys=True)
sys.stdout.write("\n")
