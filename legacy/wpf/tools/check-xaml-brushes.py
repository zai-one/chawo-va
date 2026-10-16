#!/usr/bin/env python3
"""Flag Color-typed StaticResource/DynamicResource keys used on Brush properties.

Runs on Linux without WPF. Parses App.xaml (and every other *.xaml under src/) for:
  - <Color x:Key="…"> definitions
  - <SolidColorBrush x:Key="…"> (and other *Brush) definitions
  - Attribute or Setter Property=Background|Foreground|BorderBrush|Fill|Stroke|…
    whose Value references a Color key via StaticResource or DynamicResource

Exit 0 when clean, 1 when any misuse is found. Prints every hit with file:line.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src"
BRUSH_PROPS = {
    "Background", "Foreground", "BorderBrush", "Fill", "Stroke",
    "CaretBrush", "SelectionBrush", "OpacityMask", "Color",  # Color= on a brush is OK; filtered below
}
# Properties that expect a Brush (not Color). "Color" on SolidColorBrush is valid for Color keys.
BRUSH_ONLY = BRUSH_PROPS - {"Color"}

COLOR_DEF = re.compile(
    r"""<\s*Color\b[^>]*\bx:Key\s*=\s*["']([^"']+)["']""",
    re.IGNORECASE,
)
BRUSH_DEF = re.compile(
    r"""<\s*(?:SolidColorBrush|LinearGradientBrush|RadialGradientBrush|ImageBrush|DrawingBrush|VisualBrush|Brush)\b[^>]*\bx:Key\s*=\s*["']([^"']+)["']""",
    re.IGNORECASE,
)
# Setter: Property="Background" Value="{StaticResource Foo}"
SETTER = re.compile(
    r"""<\s*Setter\b([^>]*)/?>""",
    re.IGNORECASE,
)
ATTR = re.compile(
    r"""\b(Background|Foreground|BorderBrush|Fill|Stroke|CaretBrush|SelectionBrush|OpacityMask)\s*=\s*["']([^"']+)["']""",
    re.IGNORECASE,
)
RES_REF = re.compile(
    r"""\{(?:Static|Dynamic)Resource\s+([^}]+?)\}""",
    re.IGNORECASE,
)
PROP_IN_SETTER = re.compile(r"""\bProperty\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
VAL_IN_SETTER = re.compile(r"""\bValue\s*=\s*["']([^"']+)["']""", re.IGNORECASE)


def collect_keys(xaml_files: list[Path]) -> tuple[set[str], set[str]]:
    colors: set[str] = set()
    brushes: set[str] = set()
    for path in xaml_files:
        text = path.read_text(encoding="utf-8")
        colors.update(COLOR_DEF.findall(text))
        brushes.update(BRUSH_DEF.findall(text))
    return colors, brushes


def resource_keys(value: str) -> list[str]:
    return [m.group(1).strip() for m in RES_REF.finditer(value)]


def main() -> int:
    xaml_files = sorted(ROOT.rglob("*.xaml"))
    if not xaml_files:
        print(f"no XAML under {ROOT}", file=sys.stderr)
        return 2
    colors, brushes = collect_keys(xaml_files)
    hits: list[str] = []
    for path in xaml_files:
        lines = path.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines, 1):
            # Attribute form on elements
            for prop, value in ATTR.findall(line):
                if prop not in BRUSH_ONLY:
                    continue
                for key in resource_keys(value):
                    if key in colors and key not in brushes:
                        hits.append(f"{path.relative_to(ROOT.parent)}:{i}: {prop} uses Color key '{key}'")
            # Setter form
            for setter_attrs in SETTER.findall(line):
                pm = PROP_IN_SETTER.search(setter_attrs)
                vm = VAL_IN_SETTER.search(setter_attrs)
                if not pm or not vm:
                    continue
                prop = pm.group(1)
                if prop not in BRUSH_ONLY:
                    continue
                for key in resource_keys(vm.group(1)):
                    if key in colors and key not in brushes:
                        hits.append(
                            f"{path.relative_to(ROOT.parent)}:{i}: Setter {prop} uses Color key '{key}'"
                        )
    if hits:
        print(f"found {len(hits)} Color-as-Brush misuse(s):")
        for h in hits:
            print(f"  {h}")
        return 1
    print(
        f"ok: {len(xaml_files)} XAML file(s), "
        f"{len(colors)} Color key(s), {len(brushes)} Brush key(s); no Color-as-Brush misuse"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
