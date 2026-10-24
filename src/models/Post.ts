import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/** A blog update written by the Super Admin. Plain text: blank lines split paragraphs and "## " starts a heading. */
const postSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 200 },
    excerpt: { type: String, trim: true, maxlength: 300, default: "" },
    body: { type: String, required: true, trim: true, maxlength: 20000 },
    /** Optional cover picture (a SiteAsset with purpose "blog"). */
    coverAsset: { type: Schema.Types.ObjectId, ref: "SiteAsset" },
    published: { type: Boolean, default: false, index: true },
    publishedAt: { type: Date },
    author: { type: String, trim: true, maxlength: 120 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export type PostDoc = InferSchemaType<typeof postSchema> & { _id: string };

export const Post: Model<PostDoc> = (models.Post as Model<PostDoc>) ?? model<PostDoc>("Post", postSchema);
