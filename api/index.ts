/** Vercel serverless entry. vercel.json rewrites /api/* here; Express does the routing. */
import { createApp } from '../server/app.js';

export default createApp();
