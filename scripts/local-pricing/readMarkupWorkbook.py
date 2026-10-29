"""Read the explicitly edited markup column using only Python's standard library."""
import hashlib
import json
import pathlib
import posixpath
import sys
import xml.etree.ElementTree as ET
import zipfile

path = pathlib.Path(sys.argv[1]).expanduser().resolve()
ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
rels_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
with zipfile.ZipFile(path) as archive:
    strings = []
    if "xl/sharedStrings.xml" in archive.namelist():
        strings = ["".join(node.itertext()) for node in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("s:si", ns)]
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    sheet = next(sheet for sheet in workbook.findall("s:sheets/s:sheet", ns) if sheet.attrib["name"] == "Product Pricing")
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    target = next(rel.attrib["Target"] for rel in rels if rel.attrib["Id"] == sheet.attrib[f"{{{rels_ns}}}id"])
    target = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
    headers, rows = {}, []
    for row in ET.fromstring(archive.read(target)).findall("s:sheetData/s:row", ns):
        cells = {}
        for cell in row.findall("s:c", ns):
            column = "".join(ch for ch in cell.attrib["r"] if ch.isalpha())
            value = cell.find("s:v", ns)
            value = value.text if value is not None else ""
            if cell.attrib.get("t") == "s":
                value = strings[int(value)]
            elif cell.attrib.get("t") == "inlineStr":
                value = "".join(cell.find("s:is", ns).itertext())
            cells[column] = value
            if cell.find("s:f", ns) is not None and headers.get(column) == "New markup":
                raise ValueError(f"Row {row.attrib['r']}: New markup must be an explicit value, not a formula")
        if not headers:
            headers = cells
        elif any(cells.values()):
            rows.append({"row": int(row.attrib["r"]), **{headers[key]: value for key, value in cells.items() if key in headers}})
    required = {"Product ID", "Product", "Vendor", "Package ID", "New markup"}
    if not required.issubset(set(headers.values())):
        raise ValueError("Missing required Product Pricing columns")
print(json.dumps({"source": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "sheet": "Product Pricing", "rows": rows}))
