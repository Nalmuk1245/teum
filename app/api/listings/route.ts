import { NextResponse } from "next/server";
import { recentListings } from "@/lib/listings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ listings: recentListings() });
}
