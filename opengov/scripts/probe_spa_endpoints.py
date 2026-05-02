"""Phase-2 probe: try SPA-discovered endpoint shapes.

Run: python3 opengov/scripts/probe_spa_endpoints.py
"""
import json
import httpx

DS = "92037640-2a64-4f32-9c7b-de42b7842274"
COA = "c8d0e77d-a56d-4355-8042-d85c1b5f9a7c"
ENT = "eb3265cf-3e21-4417-8e3c-04fbfdcfc1d1"
REPORT = 145174

HOSTS = ["https://reporting.opengov.com", "https://tampa.opengov.com"]
PATHS = [
    f"/api/v1/data_sets/{DS}",
    f"/api/v1/data_sets/{DS}/data",
    f"/api/v1/data_sets/{DS}/rows",
    f"/api/v1/chart_of_accounts/{COA}",
    f"/api/v1/chart_of_accounts/{COA}/accounts",
    f"/api/v1/entities/{ENT}/chart_of_accounts",
    f"/api/v1/entities/3258/chart_of_accounts",
    f"/api/transparency/v1/reports/{REPORT}",
    f"/api/transparency/v1/reports/{REPORT}/data",
    f"/api/transparency/v1/data_sets/{DS}",
    f"/api/transparency/v1/data_sets/{DS}/data",
    f"/api/grid_data/v0/data_sets/{DS}",
    f"/api/entitydata/v1/entities/{ENT}/datasets/{DS}",
]


def main() -> None:
    with httpx.Client(
        timeout=10,
        follow_redirects=False,
        headers={"Accept": "application/json"},
    ) as c:
        for host in HOSTS:
            for path in PATHS:
                try:
                    r = c.get(host + path)
                except httpx.HTTPError as e:
                    print(f"  ERR {host}{path}: {e}")
                    continue
                if r.status_code == 404:
                    continue
                ct = r.headers.get("content-type", "").split(";")[0]
                mark = "**" if r.status_code == 200 else "  "
                print(f"{mark} {r.status_code} {ct:25s} {host}{path}")
                if r.status_code == 200 and "json" in ct:
                    try:
                        body = r.json()
                    except Exception:
                        print("        (non-json body)")
                        continue
                    if isinstance(body, list):
                        print(f"        list[{len(body)}]  sample={json.dumps(body[:1])[:200]}")
                    else:
                        print(f"        keys={sorted(body.keys())[:10]}")


if __name__ == "__main__":
    main()
