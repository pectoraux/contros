// Quick cleanup script — run with bun to wipe bid test data.
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const ORG_A = 'test-bid-org-a'
const ORG_B = 'test-bid-org-b'
const CLIENT_A = 'test-bid-client-a'
const CLIENT_B = 'test-bid-client-b'
const USER_A = 'test-bid-user-a'
const USER_B = 'test-bid-user-b'

async function main() {
  console.log('Starting cleanup...')

  // Bids first.
  const bids = await db.bid.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
  console.log('Deleted bids:', bids.count)

  // Audit logs + commercial exceptions.
  const audit = await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
  console.log('Deleted audit:', audit.count)
  const ce = await db.commercialException.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
  console.log('Deleted commercial exceptions:', ce.count)

  // Estimate revisions — find all revisions whose estimate belongs to our test orgs.
  const revs = await db.estimateRevision.deleteMany({
    where: { estimate: { organizationId: { in: [ORG_A, ORG_B] } } },
  })
  console.log('Deleted revisions (via estimate.org):', revs.count)

  // Also any revisions with the test-bid-rev- prefix.
  const revs2 = await db.estimateRevision.deleteMany({
    where: { id: { startsWith: 'test-bid-rev-' } },
  })
  console.log('Deleted revisions (by id prefix):', revs2.count)

  // Estimate lines.
  const lines = await db.estimateLine.deleteMany({
    where: { estimate: { organizationId: { in: [ORG_A, ORG_B] } } },
  })
  console.log('Deleted estimate lines:', lines.count)

  // Estimates.
  const ests = await db.estimate.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  })
  console.log('Deleted estimates:', ests.count)

  // Scope items + scope packages.
  const items = await db.scopeItem.deleteMany({
    where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } },
  })
  console.log('Deleted scope items:', items.count)
  const scopes = await db.scopePackage.deleteMany({
    where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } },
  })
  console.log('Deleted scope packages:', scopes.count)

  // Opportunities.
  const opps = await db.opportunity.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  })
  console.log('Deleted opportunities:', opps.count)

  // Resource price observations + resources.
  const obs = await db.resourcePriceObservation.deleteMany({
    where: { resource: { organizationId: { in: [ORG_A, ORG_B] } } },
  })
  console.log('Deleted resource price observations:', obs.count)
  const res = await db.resource.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  })
  console.log('Deleted resources:', res.count)

  // WD versions + WDs.
  const wdvs = await db.workDefinitionVersion.deleteMany({
    where: { workDefinition: { organizationId: { in: [ORG_A, ORG_B] } } },
  })
  console.log('Deleted WD versions:', wdvs.count)
  const wds = await db.workDefinition.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  })
  console.log('Deleted WDs:', wds.count)

  // Clients + users + orgs.
  const clients = await db.client.deleteMany({ where: { id: { in: [CLIENT_A, CLIENT_B] } } })
  console.log('Deleted clients:', clients.count)
  const users = await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
  console.log('Deleted users:', users.count)
  const orgs = await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
  console.log('Deleted orgs:', orgs.count)

  console.log('Cleanup complete.')
}

main()
  .catch((e) => {
    console.error('Cleanup failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
