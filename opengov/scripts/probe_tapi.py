"""Phase-3 probe: tapi (transparency) and trapi (transactions) endpoints.

Run: python3 opengov/scripts/probe_tapi.py
"""
import json
import httpx

REPORT = 145174
ENTITY_INT = 3258
ENTITY_UUID = "eb3265cf-3e21-4417-8e3c-04fbfdcfc1d1"
COA = "c8d0e77d-a56d-4355-8042-d85c1b5f9a7c"
DS_FY26 = "92037640-2a64-4f32-9c7b-de42b7842274"

HOSTS = ["https://reporting.opengov.com", "https://tampa.opengov.com"]


def post(client: httpx.Client, host: str, path: str, body: dict) -> None:
    url = host + path
    try:
        r = client.post(url, json=body, timeout=15)
    except httpx.HTTPError as e:
        print(f"  ERR POST {url}: {e}")
        return
    ct = r.headers.get("content-type", "").split(";")[0]
    print(f"  POST {r.status_code} {ct:25s} {url}  body={list(body.keys())}")
    if r.status_code == 200 and "json" in ct:
        try:
            j = r.json()
        except Exception:
            print(f"        non-json: {r.text[:120]}")
            return
        if isinstance(j, dict):
            print(f"        keys={sorted(j.keys())[:12]}")
            for k in ("transaction_id", "transactions", "rows", "results", "data", "query_results"):
                if k in j:
                    v = j[k]
                    if isinstance(v, list):
                        print(f"        {k}: list[{len(v)}] sample={json.dumps(v[:1])[:200]}")
                    else:
                        print(f"        {k}: {str(v)[:100]}")
        elif isinstance(j, list):
            print(f"        list[{len(j)}] sample={json.dumps(j[:1])[:200]}")
    elif r.status_code in (400, 401, 403, 422):
        print(f"        {r.text[:200]}")


def main() -> None:
    with httpx.Client(headers={"Accept": "application/json"}) as c:
        # 1) Try tapi.post("select") with a few report-identifier shapes
        select_bodies = [
            {"report_id": REPORT},
            {"id": REPORT},
            {"report_id": REPORT, "entity_id": ENTITY_INT},
            {"reportId": REPORT},
        ]
        package_bodies = [
            {"report_id": REPORT, "entity_id": ENTITY_INT},
            {"id": REPORT},
        ]
        for host in HOSTS:
            print(f"\n# Host {host}")
            for body in select_bodies:
                post(c, host, "/api/transparency/v1/select", body)
            for body in package_bodies:
                post(c, host, "/api/transparency/v1/package", body)

        # 2) Try trapi.post("query/<transaction_id>") with a stub query.
        #    We don't have a transaction_id yet, but the dataset id might serve.
        candidate_tids = [DS_FY26, str(REPORT)]
        stub_query = {"fields": ["amount"], "limit": 1}
        for host in HOSTS:
            for tid in candidate_tids:
                post(c, host, f"/api/transactions/v1/query/{tid}", stub_query)


if __name__ == "__main__":
    main()
