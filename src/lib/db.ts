import mongoose from "mongoose";
import { env } from "./env";

/**
 * Cached Mongoose connection. `tsx watch` reloads modules in development, so we
 * stash the connection promise on the global object to avoid opening a new pool
 * on every reload.
 */

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

const globalForMongoose = globalThis as unknown as { _mongoose?: MongooseCache };

const cache: MongooseCache =
  globalForMongoose._mongoose ?? (globalForMongoose._mongoose = { conn: null, promise: null });

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (!env.mongodbUri) {
    throw new DatabaseNotConfiguredError();
  }

  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    mongoose.set("strictQuery", true);
    const isSrv = env.mongodbUri.startsWith("mongodb+srv://");
    cache.promise = mongoose
      .connect(env.mongodbUri, {
        bufferCommands: false,
        // Atlas / remote clusters can be slow to hand out a primary on a cold
        // connection or a poor network — be more patient than a local mongod.
        serverSelectionTimeoutMS: isSrv ? 20_000 : 8_000,
        socketTimeoutMS: 45_000,
        connectTimeoutMS: 20_000,
        maxPoolSize: 10,
        retryWrites: true,
      })
      .then((m) => m);
  }

  try {
    cache.conn = await cache.promise;
  } catch (error) {
    cache.promise = null;
    if (
      error instanceof Error &&
      /ECONNREFUSED|ETIMEDOUT|querySrv|ENOTFOUND|Authentication failed/i.test(error.message)
    ) {
      console.error(
        "[db] Could not connect to MongoDB. If you're using Atlas: (1) the URI must be the " +
          "SRV string from Atlas → Connect → Drivers, (2) add 0.0.0.0/0 under Atlas → Network " +
          "Access (Render has dynamic IPs), (3) check the username / password / db name.",
      );
    }
    throw error;
  }

  return cache.conn;
}

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("MONGODB_URI is not configured. Set it in the environment to enable persistence.");
    this.name = "DatabaseNotConfiguredError";
  }
}

/** True when a real connection can be attempted. */
export function isDbReady(): boolean {
  return Boolean(env.mongodbUri);
}
