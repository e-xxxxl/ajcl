import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    /** bcrypt hash — never selected by default. */
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["customer", "admin", "rider", "office_admin"], default: "customer", index: true },
    /** Elevated admin — can create other admins and delete bookings. */
    superAdmin: { type: Boolean, default: false },
    /** Only present when role === "rider". */
    rider: {
      plate: { type: String, trim: true, uppercase: true, maxlength: 20 },
      vehicleType: { type: String, trim: true, maxlength: 60 },
      /** Inactive riders can't log in or receive new jobs. */
      active: { type: Boolean, default: true },
      /** Most active orders this rider may hold at once. Unset = the server default. */
      maxActiveJobs: { type: Number, min: 1, max: 50 },
    },
    /** Present on partner accounts. Partners book normally but are billed on account. */
    partner: {
      active: { type: Boolean, default: false },
      company: { type: String, trim: true, maxlength: 120 },
      /** Added to every fare this partner is quoted. Negative = a discount. */
      markupPercent: { type: Number, default: 0, min: -90, max: 500 },
      /** Most the partner may owe at once. Unset = no limit. */
      creditLimit: { type: Number, min: 0 },
      notes: { type: String, trim: true, maxlength: 500 },
      since: { type: Date },
    },
    /** Password reset flow. */
    resetTokenHash: { type: String, select: false },
    resetTokenExpiresAt: { type: Date, select: false },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});

userSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.passwordHash;
    delete ret.resetTokenHash;
    delete ret.resetTokenExpiresAt;
    delete ret.__v;
    return ret;
  },
});

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: string };

export const User: Model<UserDoc> =
  (models.User as Model<UserDoc>) ?? model<UserDoc>("User", userSchema);
