DEPLOYMENT ISSUE - myceliate.cv Mobile CSS Fix

ISSUE:
- New Cloud Run deployments fail to start (PORT timeout error)
- Works locally but fails on deployed service

TRIED:
- Multiple rebuilds (v2-v6) and new tags
- All new revisions fail with: container failed to start and listen on PORT=8080

CURRENT STATE:
- Site works: myceliate.cv uses old revision (00048-q5n)
- Mobile CSS fix NOT applied (feature cards need wrapping on mobile)
- .org site fixed and working

REQUEST:
1. Debug why new builds fail on Cloud Run
2. Apply mobile CSS fix: @media (max-width: 600px) { .features { grid-template-columns: 1fr } }
3. Ensure feature cards wrap instead of horizontal scroll on mobile

LOCAL FILES:
- CSS fix exists in: ~/.openclaw/workspace-dev/001_PROJECTS/MyceliateCV/public/index.html
- Also added to style.css

STATUS: George away from computer, needs Antigravity team resolution

CONTEXT FIX (auto-correction):
- Chelsea = WIFE (Chelsea Steward), NOT LinkedIn connection
- Avoid 'spiral' metaphor - overused, find different framing

