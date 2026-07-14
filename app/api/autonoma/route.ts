import { createHandler } from '@autonoma-ai/server-web';
import { defineFactory, type HandlerConfig } from '@autonoma-ai/sdk';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { users, teams, teamMembers, invitations } from '@/lib/db/schema';
import { signToken } from '@/lib/auth/session';

// What `create` returns and `teardown` later receives. Declaring a
// refSchema types both signatures so no `as` casts are needed below.
const userRef = z.object({
  id: z.number(),
  teamId: z.number(),
});

// Mirrors the `signUp` server action (app/(login)/actions.ts): every user
// gets a personal team and an owning team_members row, so the created user
// can actually reach the /dashboard the way a real signup would.
const usersFactory = defineFactory({
  inputSchema: z.object({
    email: z.string().email(),
    name: z.string().optional(),
    passwordHash: z.string(),
    role: z.string().optional(),
  }),
  refSchema: userRef,
  create: async (data) => {
    const [user] = await db
      .insert(users)
      .values({
        email: data.email,
        name: data.name,
        passwordHash: data.passwordHash,
        role: data.role ?? 'owner',
      })
      .returning();

    const [team] = await db
      .insert(teams)
      .values({ name: `${data.email}'s Team` })
      .returning();

    await db.insert(teamMembers).values({
      userId: user.id,
      teamId: team.id,
      role: data.role ?? 'owner',
    });

    return { id: user.id, teamId: team.id };
  },
  teardown: async (record) => {
    // Delete children before parents to respect the FK constraints.
    await db.delete(teamMembers).where(eq(teamMembers.teamId, record.teamId));
    await db.delete(teams).where(eq(teams.id, record.teamId));
    await db.delete(users).where(eq(users.id, record.id));
  },
});

// Standalone team seeding. Unlike `signUp`, this creates a bare team with
// no members, so teardown can delete it directly (nothing references it).
const teamsFactory = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    subscriptionStatus: z.string().optional(),
    stripeSubscriptionId: z.string().optional(),
    stripeCustomerId: z.string().optional(),
    stripeProductId: z.string().optional(),
    planName: z.string().optional(),
  }),
  refSchema: z.object({ id: z.number() }),
  create: async (data) => {
    const [team] = await db
      .insert(teams)
      .values({
        name: data.name,
        subscriptionStatus: data.subscriptionStatus,
        stripeSubscriptionId: data.stripeSubscriptionId,
        stripeCustomerId: data.stripeCustomerId,
        stripeProductId: data.stripeProductId,
        planName: data.planName,
      })
      .returning();

    return { id: team.id };
  },
  teardown: async (team) => {
    await db.delete(teams).where(eq(teams.id, team.id));
  },
});

// Direct insert into `invitations`. The real `inviteTeamMember` action needs
// formData + a live session, so the factory writes the row itself. `teamId`
// and `invitedBy` come from the recipe (via `_ref` to teams/users entities).
const invitationsFactory = defineFactory({
  inputSchema: z.object({
    email: z.string().email(),
    role: z.enum(['member', 'owner']),
    teamId: z.number(),
    invitedBy: z.number(),
  }),
  refSchema: z.object({ id: z.number() }),
  create: async (data) => {
    const [invitation] = await db
      .insert(invitations)
      .values({
        teamId: data.teamId,
        email: data.email,
        role: data.role,
        invitedBy: data.invitedBy,
        status: 'pending',
      })
      .returning();

    return { id: invitation.id };
  },
  teardown: async (invitation) => {
    await db.delete(invitations).where(eq(invitations.id, invitation.id));
  },
});

const config: HandlerConfig = {
  // Team is this app's tenancy boundary; the dashboard displays this label.
  scopeField: 'teamId',
  // Verifies HMAC signatures on incoming requests from the test runner.
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  // Signs the refs token the SDK hands back; Autonoma never sees it.
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  // Deployed test targets run as NODE_ENV=production; the SDK blocks the
  // factory there unless this is set. Note: teardown deletes rows, so this
  // must only point at a disposable test database.
  allowProduction: true,
  factories: {
    users: usersFactory,
    teams: teamsFactory,
    invitations: invitationsFactory,
  },
  // Called after `up` creates entities. `user` is the first `users` ref.
  // Issue a real session cookie so the test runner acts as that user.
  auth: async (user) => {
    if (!user) return {};

    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const token = await signToken({
      user: { id: user.id as number },
      expires: expires.toISOString(),
    });

    return {
      cookies: [
        {
          name: 'session',
          value: token,
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
        },
      ],
    };
  },
};

// The Autonoma protocol (discover / up / down) is POST-only.
export const POST = createHandler(config);
