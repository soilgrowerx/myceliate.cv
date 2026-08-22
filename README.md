# Myceliate.cv — Production Application Layer

> **Proprietary & Confidential** · Part of the [STIM Protocol](https://github.com/STIM-Protocol) Ecosystem.

`myceliate-cv` is the production web application and multi-tenant persona node orchestration layer powering [myceliate.cv](https://myceliate.cv).

---

## 🏛️ Architecture Overview

```
                          ┌────────────────────────────────────────────────────────┐
                          │                     MYCELIATE.CV                       │
                          ├────────────────────────────────────────────────────────┤
                          │                                                        │
  User / Browser ─────────┼──▶ Express Application Gateway (Cloud Run)             │
                          │     ├── Google OAuth & Session Middleware (cv_auth)    │
                          │     ├── Multi-Tenant Namespace Isolation (fix-399)     │
                          │     ├── Dynamic Claude Desktop .mcpb Generator          │
                          │     ├── Brain Seeding Multi-Modal Pipeline (fix-400)   │
                          │     ├── Stripe Checkout & Webhook Integration          │
                          │     └── Operator Dashboard (1,396 Canonical Docs)      │
                          │                                                        │
  AI Agents (Claude / Pi) ┼──▶ POST /mcp/:username (Per-User Scoped Gateway)       │
                          │     └── Bearer mb_live_* Token Auth Boundary           │
                          │                                                        │
                          └──────────────────────────┬─────────────────────────────┘
                                                     │
                                                     ▼
                          ┌────────────────────────────────────────────────────────┐
                          │               STIM PROTOCOL SUBSTRATE                  │
                          ├────────────────────────────────────────────────────────┤
                          │  • mycelial-brain-mcp (Canonical Cloud Run Engine)     │
                          │  • Google Cloud Storage (mycelial-brain-storage)       │
                          │  • STIM Layer 0 Thermodynamic Attestation Log          │
                          └────────────────────────────────────────────────────────┘
```

---

## 🔑 Core Features

1. **Multi-Tenant Persona Nodes (`users/:username/`)**:
   - Complete namespace isolation across document lists, reads, searches, and seeding.
   - Per-user in-memory vault cache maps (`userVaultCaches`) with automated TTL invalidation.
   - Foundation operator vault (1,396 canonical docs) strictly isolated from tenant spaces.

2. **Per-User MCP Gateway (`POST /mcp/:username`)**:
   - Exposes standard Model Context Protocol (MCP) JSON-RPC endpoints for autonomous agent integration.
   - Authentication gated via `mb_live_*` API keys with SHA-256 validation.

3. **Dynamic `.mcpb` Bundle Generator**:
   - Generates tailored Claude Desktop Extension ZIP bundles (`GET /api/download-mcpb/:username`) implementing Anthropic's `.mcpb` spec with Bearer token injection bridges.

4. **Multi-Modal Brain Seeding Pipeline (`POST /api/seed-brain`)**:
   - Universal payload parser accepting markdown, PDFs, bios, text blobs, and direct document arrays.
   - Automated granular section splitting for resumes and complex documentation.

5. **Ranked Scored Search Engine (`POST /api/brain/search`)**:
   - Multi-term token matching with hierarchical scoring (Whole Tag: +20, Exact Phrase: +15, Partial Tag: +10, Title/Path: +5, Content: +1).
   - Standardized `query` and `q` parameter compatibility.

6. **Stripe Billing Integration**:
   - Three subscription tiers: Sovereign Persona ($4/mo or $36/yr), Swarm Collective ($14/mo or $126/yr), Enterprise Substrate ($49/mo or $441/yr).
   - Instant automated webhook provisioning.

---

## 🚀 Deployment

### Cloud Run Production Deployment
```bash
gcloud run deploy myceliate-cv \
  --project=arboracle \
  --region=us-central1 \
  --source=. \
  --allow-unauthenticated \
  --port=8080
```

---

## 📜 License

Proprietary — Copyright © 2026 STIM Protocol / SoilGrower. All rights reserved.
