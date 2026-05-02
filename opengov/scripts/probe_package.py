"""Hit the transparency package endpoint with the FY2026 dataset.

POST https://reporting.opengov.com/api/transparency/v1/package/{coa_id}

Body shape derived from the SPA:
    coa_mask_id, data_sets[], mask, serve_old, state_scale, ungroup, api
"""
import json
import httpx

REPORT_ID = 145174
COA = "c8d0e77d-a56d-4355-8042-d85c1b5f9a7c"


def main() -> None:
    with httpx.Client(headers={"Accept": "application/json"}, timeout=60) as c:
        # Pull the report metadata to harvest data_set IDs and coa_mask_id.
        meta = c.get(
            f"https://reporting.opengov.com/api/v1/reports/{REPORT_ID}"
        ).json()
        data_set_ids = [ds["id"] for ds in meta["data_sets"]]
        coa_mask_id = meta.get("coa_mask_id")
        coa_id = meta.get("coa_id", COA)

        body = {
            "coa_mask_id": coa_mask_id,
            "data_sets": data_set_ids,
            "mask": None,
            "serve_old": True,
            "state_scale": False,
            "ungroup": None,
            "api": None,
        }
        print("Request body:")
        print(json.dumps(body, indent=2))

        for host in [
            "https://reporting.opengov.com",
            "https://tampa.opengov.com",
        ]:
            url = f"{host}/api/transparency/v1/package/{coa_id}"
            r = c.post(url, json=body)
            print(f"\n{r.status_code}  {r.headers.get('content-type')}  {url}")
            if r.status_code != 200:
                print("  ", r.text[:400])
                continue
            j = r.json()
            print("  top keys:", sorted(j.keys()))
            for k in ("trees", "data_sets", "datasets", "aggregations", "schema"):
                v = j.get(k)
                if v is None:
                    continue
                if isinstance(v, list):
                    print(f"  {k}: list[{len(v)}]")
                    if v:
                        item = v[0]
                        if isinstance(item, dict):
                            print(f"    item keys: {sorted(item.keys())}")
                else:
                    print(f"  {k}: {type(v).__name__}")
            # Save the full response for inspection.
            out = "/tmp/og_package_response.json"
            with open(out, "w") as fh:
                json.dump(j, fh, indent=2)
            print(f"  full response written to {out}")
            return


if __name__ == "__main__":
    main()
