#!/usr/bin/env python3
"""Linux guard for the ComboBox chrome (no WPF needed).

Why: App.xaml sets ThemeMode="Dark", which merges the Fluent dictionary into
Application.Resources. Fluent's implicit styles for ToggleButton, RepeatButton,
RadioButton, CheckBox, Button and Expander set HorizontalAlignment=Left and/or
VerticalAlignment=Center. Any such control placed inside one of our ControlTemplates
without its own Style picks those setters up and shrinks to its desired size. That
is what broke every ComboBox in 1.17.2: the toggle (the whole dark field) collapsed
to a ~28x6 px blob at the left while the selected text sat outside it.

Checks:
  1. every *.xaml under src/ is well-formed XML;
  2. inside every ControlTemplate, Fluent-aligned control types carry an explicit
     Style (or the app defines its own implicit style for that type);
  3. the ComboBox template: ToggleButton uses a keyed style with
     OverridesDefaultStyle=True and Stretch/Stretch, never Left/Center locally;
     Root has no fixed size or alignment; the toggle template has columns * | 28 with
     the chrome spanning both and the arrow in column 1 (no Width > 28, no Stretch=Fill);
     ComboBox MinHeight >= 30; the text sits left of the arrow column;
  4. no ComboBox in any window overrides Style/Template or sets Height < 30.

    python3 tools/check-xaml-combobox.py                 # src/
    python3 tools/check-xaml-combobox.py --app OLD.xaml  # check another App.xaml
Exit 0 when clean, 1 with a list of problems.
"""
from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
P = "{http://schemas.microsoft.com/winfx/2006/xaml/presentation}"
X = "{http://schemas.microsoft.com/winfx/2006/xaml}"
# Fluent (PresentationFramework.Fluent/Styles) implicit styles that set Left and/or Center.
FLUENT_ALIGNED = {"Button", "ToggleButton", "RepeatButton", "RadioButton", "CheckBox", "Expander", "ComboBox"}

problems: list[str] = []


def bad(msg: str) -> None:
    problems.append(msg)


def tag(el: ET.Element) -> str:
    return el.tag.replace(P, "")


def setters(style: ET.Element) -> dict[str, str]:
    out = {}
    for s in style.iter(P + "Setter"):
        if s.get("Property") and s.get("Value") is not None:
            out.setdefault(s.get("Property"), s.get("Value"))
        elif s.get("Property"):
            out.setdefault(s.get("Property"), "<element>")
    return out


def static_key(value: str | None) -> str | None:
    m = re.fullmatch(r"\{StaticResource\s+([^}\s]+)\s*\}", (value or "").strip())
    return m.group(1) if m else None


def parse(path: Path) -> ET.Element | None:
    try:
        return ET.parse(path).getroot()
    except ET.ParseError as e:
        bad(f"{path}: not well-formed XML: {e}")
        return None


def implicit_style_types(root: ET.Element) -> set[str]:
    res = root.find(P + "Application.Resources")
    if res is None:
        return set()
    return {s.get("TargetType") for s in res.findall(P + "Style") if s.get(X + "Key") is None}


def check_templates(path: Path, root: ET.Element, app_implicit: set[str]) -> None:
    for tpl in root.iter(P + "ControlTemplate"):
        for el in tpl.iter():
            t = tag(el)
            if t in FLUENT_ALIGNED and el is not tpl and el.get("Style") is None and t not in app_implicit:
                bad(f"{path.name}: <{t} x:Name={el.get(X + 'Name')!r}> inside ControlTemplate "
                    f"{tpl.get(X + 'Key') or tpl.get('TargetType')!r} has no Style: Fluent's implicit "
                    f"style will set HorizontalAlignment=Left / VerticalAlignment=Center on it")


def check_combobox(path: Path, root: ET.Element) -> None:
    res = root.find(P + "Application.Resources")
    keyed = {el.get(X + "Key"): el for el in res if el.get(X + "Key")}
    combo = next((s for s in res.findall(P + "Style")
                  if s.get("TargetType") == "ComboBox" and s.get(X + "Key") is None), None)
    if combo is None:
        bad(f"{path.name}: no implicit ComboBox style")
        return
    cs = setters(combo)
    try:
        if float(cs.get("MinHeight", "0")) < 30:
            bad(f"{path.name}: ComboBox MinHeight {cs.get('MinHeight')} < 30")
    except ValueError:
        bad(f"{path.name}: ComboBox MinHeight not numeric: {cs.get('MinHeight')}")
    if cs.get("OverridesDefaultStyle") != "True":
        bad(f"{path.name}: ComboBox style must set OverridesDefaultStyle=True")
    tpl = next(combo.iter(P + "ControlTemplate"), None)
    if tpl is None:
        bad(f"{path.name}: ComboBox style has no ControlTemplate")
        return
    rootgrid = next(iter(tpl), None)
    for a in ("Width", "Height", "MaxWidth", "MaxHeight"):
        if rootgrid is not None and rootgrid.get(a):
            bad(f"{path.name}: ComboBox template root has fixed {a}={rootgrid.get(a)}")
    for a, ok in (("HorizontalAlignment", "Stretch"), ("VerticalAlignment", "Stretch")):
        if rootgrid is not None and rootgrid.get(a, ok) != ok:
            bad(f"{path.name}: ComboBox template root {a}={rootgrid.get(a)} (must stretch)")

    toggle = next((e for e in tpl.iter(P + "ToggleButton") if e.get(X + "Name") == "ToggleButton"), None)
    if toggle is None:
        bad(f"{path.name}: ComboBox template has no ToggleButton named ToggleButton")
        return
    for a in ("HorizontalAlignment", "VerticalAlignment"):
        if toggle.get(a, "Stretch") != "Stretch":
            bad(f"{path.name}: ComboBox ToggleButton {a}={toggle.get(a)} (must be Stretch)")
    for a in ("Width", "Height", "MaxWidth", "MaxHeight"):
        if toggle.get(a):
            bad(f"{path.name}: ComboBox ToggleButton has fixed {a}={toggle.get(a)}")
    key = static_key(toggle.get("Style"))
    style = keyed.get(key) if key else None
    toggle_tpl_key = static_key(toggle.get("Template"))
    if style is None:
        bad(f"{path.name}: ComboBox ToggleButton has no keyed Style (got {toggle.get('Style')!r}); "
            f"Fluent's implicit ToggleButton style (Left/Center) would apply")
    else:
        ss = setters(style)
        if style.get("TargetType") != "ToggleButton":
            bad(f"{path.name}: style {key} TargetType={style.get('TargetType')}")
        if style.get("BasedOn"):
            bad(f"{path.name}: style {key} must not be BasedOn anything (got {style.get('BasedOn')})")
        for prop, want in (("OverridesDefaultStyle", "True"), ("HorizontalAlignment", "Stretch"),
                           ("VerticalAlignment", "Stretch")):
            if ss.get(prop) != want:
                bad(f"{path.name}: style {key} must set {prop}={want} (got {ss.get(prop)!r})")
        toggle_tpl_key = toggle_tpl_key or static_key(ss.get("Template"))
    ttpl = keyed.get(toggle_tpl_key) if toggle_tpl_key else None
    if ttpl is None or tag(ttpl) != "ControlTemplate":
        bad(f"{path.name}: ComboBox toggle template not found ({toggle_tpl_key!r})")
        return
    grid = next(iter(ttpl))
    if tag(grid) != "Grid":
        bad(f"{path.name}: toggle template root is <{tag(grid)}>, expected Grid")
        return
    for a in ("HorizontalAlignment", "VerticalAlignment"):
        if grid.get(a, "Stretch") != "Stretch":
            bad(f"{path.name}: toggle template Grid {a}={grid.get(a)}")
    cols = [c.get("Width", "*") for c in grid.iter(P + "ColumnDefinition")]
    if cols != ["*", "28"]:
        bad(f"{path.name}: toggle columns {cols}, expected ['*', '28']")
    chrome = next((e for e in grid if e.get(X + "Name") == "Chrome"), None)
    if chrome is None or chrome.get("Grid.ColumnSpan") != "2":
        bad(f"{path.name}: toggle Chrome must span both columns")
    if chrome is not None and any(chrome.get(a) for a in ("Width", "Height", "HorizontalAlignment", "VerticalAlignment")):
        bad(f"{path.name}: toggle Chrome must not set a size or alignment")
    arrow = next((e for e in grid if e.get(X + "Name") == "Arrow"), None)
    if arrow is None or arrow.get("Grid.Column") != "1":
        bad(f"{path.name}: Arrow must sit in Grid.Column=1")
    elif arrow is not None:
        if arrow.get("Stretch") == "Fill":
            bad(f"{path.name}: Arrow Stretch=Fill distorts the chevron")
        for a in ("Width", "MinWidth"):
            if arrow.get(a) and float(arrow.get(a)) > 28:
                bad(f"{path.name}: Arrow {a}={arrow.get(a)} wider than its 28 px column")
    site = next((e for e in tpl.iter(P + "ContentPresenter") if e.get(X + "Name") == "ContentSite"), None)
    if site is None:
        bad(f"{path.name}: ComboBox template has no ContentSite")
    else:
        m = [float(v) for v in (site.get("Margin") or "0").split(",")]
        right = m[2] if len(m) == 4 else m[0]
        if right < 28:
            bad(f"{path.name}: ContentSite right margin {right} < 28 (text runs under the arrow)")
        if "SelectionBoxItem" not in (site.get("Content") or ""):
            bad(f"{path.name}: ContentSite must show SelectionBoxItem")


def check_usages(path: Path, root: ET.Element) -> None:
    for el in root.iter(P + "ComboBox"):
        name = el.get(X + "Name")
        if el.get("Style") or el.get("Template"):
            bad(f"{path.name}: ComboBox {name} overrides Style/Template; it would lose the dark chrome")
        h = el.get("Height")
        if h and h != "Auto" and float(h) < 30:
            bad(f"{path.name}: ComboBox {name} Height={h} < 30")
        if el.find(P + "ComboBox.Template") is not None or el.find(P + "ComboBox.Style") is not None:
            bad(f"{path.name}: ComboBox {name} sets Template/Style as property element")


def main() -> int:
    app = SRC / "App.xaml"
    if "--app" in sys.argv:
        app = Path(sys.argv[sys.argv.index("--app") + 1])
    files = sorted(p for p in SRC.rglob("*.xaml") if "/obj/" not in str(p) and "/bin/" not in str(p))
    roots = {}
    for f in files:
        r = parse(app if f.name == "App.xaml" and f.parent == SRC else f)
        if r is not None:
            roots[f] = r
    app_root = roots.get(SRC / "App.xaml")
    if app_root is None:
        bad("App.xaml missing or unparsable")
    else:
        implicit = implicit_style_types(app_root)
        for f, r in roots.items():
            check_templates(f, r, implicit if f != SRC / "App.xaml" else implicit - {"ComboBox"})
            check_usages(f, r)
        check_combobox(app, app_root)
    if problems:
        print(f"found {len(problems)} ComboBox/template problem(s):")
        for p in problems:
            print(f"  {p}")
        return 1
    print(f"ok: {len(roots)} XAML file(s); ComboBox toggle stretches (keyed style, OverridesDefaultStyle, "
          f"Stretch/Stretch), columns * | 28, MinHeight >= 30; no Fluent-aligned control without a Style "
          f"inside any ControlTemplate")
    return 0


if __name__ == "__main__":
    sys.exit(main())
