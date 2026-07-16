# LoadMode / Freight Copilot

A single-user freight-forwarding automation workspace for reducing repetitive quotation and operations work.

The app combines carrier portal automation, AI-assisted data extraction, shipment organization, rate history, quote generation, trucking/drayage workflows, reporting support, and email drafting. It is designed to run with the freight forwarder's existing carrier portal accounts and preserve source evidence for human verification.

## Current capabilities

- Retrieve, normalize, rank, and store ocean rates from supported carrier portals.
- Run multi-carrier quote bundles and generate customer-facing email replies.
- Parse customer requests from text, screenshots, PDFs, and Outlook `.msg` files.
- Parse carrier rate sheets and search previously extracted lanes.
- Generate quotation PDFs and CSV history exports.
- Store drayage and FTL/LTL requests, rates, markups, and source documents.
- Generate drayage estimates from verified matching lane history when no live provider workflow is available.
- Maintain a shipment board and extract shipment details from uploaded briefings.
- Keep carrier sessions active and report live login status.
- Run recorded browser workflows and scheduled AI agents.

## Important limitations

- Browser automations depend on carrier portal layouts and require monitoring when carriers change their websites.
- Historical drayage estimates are planning tools, not firm trucker quotations. Confidence, range, source count, and source age must be reviewed before use.
- Some trucking and drayage providers still require direct integrations or recorded workflows.
- AI-extracted rates and generated emails require human review before being sent to a customer.

## Development status

The application is a working single-user internal tool under active development. The main priority is increasing dependable automation coverage for:

1. Ocean carrier rate retrieval and validation.
2. Drayage and trucking rate retrieval.
3. Email intake, reply drafting, and rate extraction.
4. Shipment milestone updates and exception alerts.
5. Customer and internal status reporting.

## Local commands

```bash
pnpm install
pnpm dev serve                 # start the web dashboard
pnpm dev maersk login          # save a carrier portal session
pnpm dev quote --help          # run a CLI quotation
pnpm dev history               # inspect quote history
pnpm build                     # TypeScript production build
pnpm db:push                   # apply the current database schema
```

## Operating principle

Automation should remove manual copying and repetitive navigation without hiding uncertainty. Every rate used for a customer quotation should remain traceable to a carrier result, provider quote, uploaded rate sheet, or clearly labelled historical estimate.
