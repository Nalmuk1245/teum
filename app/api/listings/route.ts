import { NextResponse } from "next/server";
import { recentListings, watchStatus } from "@/lib/listings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ listings: recentListings(), watch: watchStatus() });
}
