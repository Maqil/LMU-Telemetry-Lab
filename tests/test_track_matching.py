import sys
import os

# Add the project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from backend.app.utils.track_db import find_track_in_registry

test_cases = [
    "Algarve International Circuit",
    "Circuit de la Sarthe",
    "Le Mans",
    "Monza",
    "Autodromo Nazionale Monza",
    "Spa",
    "Circuit of the Americas",
    "Austin",
    "Le Castellet",
    "Sakhir",
    "Portimao",
    "Algarve"
]

# Names that must resolve to one specific circuit. "Daytona" guards the fuzzy
# matcher: difflib scores it 0.62 against "Fuji Speedway" purely on the shared
# "speedway", which used to file every Daytona session under Fuji.
expected = {
    "Daytona International Speedway": "Daytona International Speedway",
    "Daytona Road Course": "Daytona International Speedway",
    "Fuji Speedway": "Fuji Speedway",
    "Le Mans": "Circuit de La Sarthe",
    "Sakhir": "Bahrain International Circuit",
}
test_cases += [n for n in expected if n not in test_cases]

print(f"{'Input Name':<40} | {'Matched Key':<45} | {'Result'}")
print("-" * 100)

failures = 0
for name in test_cases:
    key, data = find_track_in_registry(name)
    want = expected.get(name)
    ok = (key == want) if want else bool(key)
    if not ok:
        failures += 1
    result = "PASS" if ok else f"FAIL (expected {want})"
    print(f"{name:<40} | {str(key):<45} | {result}")

print("-" * 100)
print("ALL TESTS PASSED!" if not failures else f"{failures} TEST(S) FAILED")
sys.exit(1 if failures else 0)
