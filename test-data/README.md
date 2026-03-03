# ANBUD Test Documents

Use these PDFs to test upload, AI extraction, risk surfacing, and snapshot generation:

- `/Users/sakariaahmed/Code/anbud/test-data/tenders/tender_nordic_hybrid_cloud_2026.pdf`
- `/Users/sakariaahmed/Code/anbud/test-data/tenders/tender_city_smart_mobility_data_platform.pdf`
- `/Users/sakariaahmed/Code/anbud/test-data/tenders/tender_helio_erp_finops_managed_services.pdf`

## What each document stresses

1. `tender_nordic_hybrid_cloud_2026.pdf`
- Strong technical requirements (`must`, `shall` language)
- Explicit deliverables and milestone deadlines
- Commercial budget constraints and SLA penalty ambiguity
- Multiple clarification/TBD statements

2. `tender_city_smart_mobility_data_platform.pdf`
- Public-sector compliance and audit constraints
- Multi-stakeholder functional requirements
- Procurement timeline and weighted evaluation model
- Open questions that should populate uncertainties

3. `tender_helio_erp_finops_managed_services.pdf`
- Managed services SLA and incident response requirements
- Transition planning and operational deliverables
- FinOps/commercial envelope constraints
- Dependency and operational risk register

## Suggested test flow

1. Create 3 tenders in API/Swagger UI (`POST /api/v1/tenders`).
2. Upload one PDF per tender (`POST /api/v1/tenders/{tender_id}/documents`).
3. Let worker process jobs and generate analysis + tender page + snapshots.
4. Check dashboard (`GET /api/v1/dashboard`) for risk/deadline/phase visibility.
5. Create a new bid round (`POST /api/v1/tenders/{tender_id}/bid-rounds`) and set phase `Negotiation`.
6. Log customer answer (`POST /api/v1/tenders/{tender_id}/customer-answers`) and verify new snapshot history.
7. Add explicit event entries (`POST /api/v1/tenders/{tender_id}/events`) for pricing/deadline/scope changes.

## Optional regeneration

If you want to regenerate the PDFs:

```bash
python3 /Users/sakariaahmed/Code/anbud/scripts/generate_test_tender_pdfs.py
```
