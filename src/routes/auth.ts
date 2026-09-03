import { Router } from "express";
import { connectToDatabase } from "../lib/db";
import { ok, asyncHandler, parse, ApiError } from "../lib/api";
import {
  signupSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../lib/validation/auth";
import { hashPassword, verifyPassword, createResetToken, hashResetToken } from "../lib/auth/password";
import {
  signSession,
  SESSION_MAX_AGE_SECONDS,
  SHORT_SESSION_MAX_AGE_SECONDS,
} from "../lib/auth/jwt";
import { getCurrentUser } from "../lib/auth/middleware";
import { enforceRateLimit } from "../lib/rate-limit";
import { ensureBootstrapped } from "../lib/bootstrap";
import { env } from "../lib/env";
import { User } from "../models/User";
import { sendEmail } from "../lib/email/send";
import { passwordResetEmail, welcomeEmail } from "../lib/email/templates";

export const authRouter = Router();

function issueToken(
  claims: {
    sub: string;
    role: "customer" | "admin";
    email: string;
    name: string;
    superAdmin?: boolean;
  },
  remember: boolean,
) {
  return signSession(claims, remember ? SESSION_MAX_AGE_SECONDS : SHORT_SESSION_MAX_AGE_SECONDS);
}

/** POST /api/auth/signup */
authRouter.post(
  "/signup",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "signup", { limit: 8, windowMs: 60 * 60 * 1000 });
    const input = parse(signupSchema, req.body);

    await connectToDatabase();
    await ensureBootstrapped();

    const existing = await User.findOne({ email: input.email }).lean();
    if (existing) {
      throw new ApiError("An account with that email already exists. Try logging in.", 409);
    }

    const user = await User.create({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      passwordHash: await hashPassword(input.password),
      role: "customer",
      lastLoginAt: new Date(),
    });

    const token = await issueToken(
      {
        sub: String(user._id),
        role: "customer",
        email: user.email,
        name: `${user.firstName} ${user.lastName}`.trim(),
      },
      true,
    );

    // Fire-and-forget welcome email.
    void (async () => {
      const { subject, html, text } = welcomeEmail({ name: user.firstName });
      await sendEmail({ to: user.email, subject, html, text });
    })();

    return ok(
      res,
      {
        token,
        user: {
          id: String(user._id),
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: `${user.firstName} ${user.lastName}`.trim(),
          email: user.email,
          phone: user.phone,
          role: "customer" as const,
        },
      },
      201,
    );
  }),
);

/** POST /api/auth/login */
authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "login", { limit: 12, windowMs: 15 * 60 * 1000 });
    const input = parse(loginSchema, req.body);

    await connectToDatabase();
    await ensureBootstrapped();

    const user = await User.findOne({ email: input.email }).select("+passwordHash");
    const valid = user ? await verifyPassword(input.password, user.passwordHash) : false;

    if (!user || !valid) {
      throw new ApiError("Incorrect email or password.", 401);
    }

    user.lastLoginAt = new Date();
    await user.save();

    const superAdmin = Boolean(user.superAdmin);
    const token = await issueToken(
      {
        sub: String(user._id),
        role: user.role as "customer" | "admin",
        email: user.email,
        name: `${user.firstName} ${user.lastName}`.trim(),
        superAdmin,
      },
      input.remember,
    );

    return ok(res, {
      token,
      user: {
        id: String(user._id),
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: `${user.firstName} ${user.lastName}`.trim(),
        email: user.email,
        phone: user.phone,
        role: user.role as "customer" | "admin",
        superAdmin,
      },
    });
  }),
);

/** POST /api/auth/logout — client-only (drop the token); kept for API symmetry. */
authRouter.post(
  "/logout",
  asyncHandler(async (_req, res) => ok(res, { loggedOut: true })),
);

/** GET /api/auth/me */
authRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    return ok(res, { user });
  }),
);

/** POST /api/auth/forgot-password */
authRouter.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "forgot-password", { limit: 5, windowMs: 30 * 60 * 1000 });
    const { email } = parse(forgotPasswordSchema, req.body);

    await connectToDatabase();
    const user = await User.findOne({ email });

    let devResetUrl: string | undefined;
    if (user) {
      const { token, tokenHash, expiresAt } = createResetToken();
      user.set("resetTokenHash", tokenHash);
      user.set("resetTokenExpiresAt", expiresAt);
      await user.save();

      const resetUrl = `${env.frontendUrl}/reset-password?token=${token}`;
      console.info(`[auth] password reset requested for ${email}`);

      const { subject, html, text } = passwordResetEmail({ name: user.firstName, resetUrl });
      const sent = await sendEmail({ to: user.email, subject, html, text });
      // In dev (or when email isn't configured) hand the link back so the flow is testable.
      if (!sent || !env.isProd) devResetUrl = resetUrl;
    }

    return ok(res, {
      message: "If an account exists for that email, a reset link has been sent.",
      devResetUrl,
    });
  }),
);

/** POST /api/auth/reset-password */
authRouter.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "reset-password", { limit: 10, windowMs: 30 * 60 * 1000 });
    const input = parse(resetPasswordSchema, req.body);

    await connectToDatabase();
    const tokenHash = hashResetToken(input.token);
    const user = await User.findOne({ resetTokenHash: tokenHash }).select(
      "+resetTokenHash +resetTokenExpiresAt",
    );

    const expiresAt = user?.get("resetTokenExpiresAt") as Date | undefined;
    if (!user || !expiresAt || expiresAt.getTime() < Date.now()) {
      throw new ApiError("This reset link is invalid or has expired. Request a new one.", 400);
    }

    user.passwordHash = await hashPassword(input.password);
    user.set("resetTokenHash", undefined);
    user.set("resetTokenExpiresAt", undefined);
    await user.save();

    return ok(res, { message: "Your password has been reset. You can now log in." });
  }),
);
