import { NextRequest, NextResponse } from "next/server";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080/api/v1";

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ token: string; path: string[] }> },
) {
  const { token, path } = await params;
  const filePath = path.join("/");
  const gatewayUrl = `${API_BASE}/share/public/${token}/f/${filePath}`;

  try {
    const response = await fetch(gatewayUrl);

    if (!response.ok) {
      return new NextResponse(
        response.status === 404 ? "Not found" : "Error fetching file",
        { status: response.status },
      );
    }

    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    const data = await response.arrayBuffer();

    return new NextResponse(data, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control":
          response.headers.get("cache-control") ?? "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Internal error", { status: 500 });
  }
}
