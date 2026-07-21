# Feature readiness and UI audit

This audit separates **technical availability** from **operational readiness**. A feature can work correctly and still require human review because freight rates, customs classifications, carrier schedules, and AI-extracted data must be verified before use.

## Readiness definitions

- **Ready** — dependable application workflow with required local dependencies available.
- **Ready · review required** — workflow functions, but its commercial or AI-generated output must be checked before use.
- **Setup required** — optional integration or security configuration is missing.
- **Experimental** — functional automation depends on external websites or unattended AI behavior and may break without warning.
- **Unavailable** — a required table, credential, or service is missing.

## Feature audit

| Area | Feature | Readiness | Verification and limitations |
|---|---|---:|---|
| Shipments | Editable shipment spreadsheet | Ready | Database-backed rows, inline editing, filters, saved column layout, attachments and spreadsheet paste. |
| Shipments | AI document extraction | Review required | Supports PDFs, images, email files and text. Extracted values must be reviewed before acceptance. |
| Shipments | Containers and milestones | Ready | Requires `shipment_containers`. |
| Shipments | Follow-ups and operational notes | Ready | Requires `shipment_follow_ups`. |
| Shipments | Shipment update intake and reports | Ready | Generated summaries and email drafts require user review. |
| Shipments | DelayPredict tracking | Setup required | Requires `DELAYPREDICT_URL` and a reachable DelayPredict instance. |
| Ocean freight | Carrier rate-sheet parsing | Review required | AI output must be checked for lane, equipment, validity, totals and destination-charge treatment. |
| Ocean freight | Quote comparison and email generation | Review required | Commercial wording and rates remain editable before sending. |
| Ocean freight | Live carrier portal automation | Experimental | Requires real Chrome, valid sessions and maintained browser workflows. Carrier layout changes can break automation. |
| Drayage | Saved quotation library | Ready | Requires `drayage_quotes`. |
| Drayage | Historical lane estimation | Review required | Planning guidance only; not a firm trucker quotation. |
| Drayage | Regular FTL/LTL rates | Review required | Confirm equipment, accessorials, validity and capacity with the provider. |
| Customs | USA import clearance quotation | Review required | Classification, duties, taxes, bond and government-agency requirements must be verified. |
| Customs | Canada import clearance quotation | Review required | Classification, GST/HST, duties and agency requirements must be verified. |
| Customs | Export clearance quotation | Review required | Filing, permit and inspection requirements must be verified. |
| Client quotes | Preview and PDF generation | Ready | Markup remains internal; output requires final commercial review. |
| Rate intake | Universal rate-file import | Review required | Imported rows require source and field verification. |
| Automation | Recorded workflows | Experimental | Replay depends on the recorded website remaining structurally compatible. |
| Automation | Scheduled AI agents | Experimental | Task definitions and outputs must be monitored before unattended reliance. |
| System | Database readiness | Ready when all required tables exist | `/api/health/ready` verifies connection and required tables. |
| System | Basic authentication | Setup required unless configured | Required before exposing the dashboard publicly. |

## UI audit changes

The core navigation is limited to the four frequent workspaces:

1. Shipments
2. Ocean freight
3. Drayage
4. Customs clearance

Less frequent tools remain under **More**. A permanent **Readiness** control in the header opens the feature-readiness dashboard. Each core workspace now begins with a short description and one practical “How to use this page” instruction.

The readiness dashboard shows:

- core database status;
- required table availability;
- AI, browser, tracking and authentication configuration;
- every major feature grouped by workspace;
- an explicit state and required user action for each feature.

## Production verification boundary

Automated tests verify application behavior with controlled API responses. Final production verification still requires the deployed Replit environment, real database, actual secrets, live external services, real shipment files, and carrier portal sessions. The readiness dashboard is designed to make those remaining conditions visible instead of implying that every optional integration is active.
