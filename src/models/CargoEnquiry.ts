import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/** A request from the Air Cargo or Sea Cargo page. Kept on record in case the email to the office is lost. */
const cargoEnquirySchema = new Schema(
  {
    service: { type: String, enum: ["air", "sea", "express"], required: true },
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, required: true, trim: true, maxlength: 300 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    destination: { type: String, required: true, trim: true, maxlength: 160 },
    items: { type: String, required: true, trim: true, maxlength: 3000 },
    emailed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type CargoEnquiryDoc = InferSchemaType<typeof cargoEnquirySchema> & { _id: string };

export const CargoEnquiry: Model<CargoEnquiryDoc> =
  (models.CargoEnquiry as Model<CargoEnquiryDoc>) ?? model<CargoEnquiryDoc>("CargoEnquiry", cargoEnquirySchema);
