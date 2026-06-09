// Rate limiting map (IP -> timestamp[])
const rateLimitMap = new Map();
const LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 10;    // 10 requests per minute

export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  // Set standard CORS headers for safety
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = [
    "https://meetings.tampamonitor.com",
    "http://localhost:8788",
    "http://localhost:8080"
  ];
  
  const headers = new Headers();
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, X-Webhook-Secret");
    headers.set("Access-Control-Allow-Credentials", "true");
  }

  // Handle preflight OPTIONS request
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  // Simple IP rate limiting for subscription/keyword endpoints
  const isPost = request.method === "POST";
  const isSubscribeOrManage = url.pathname.includes("/api/subscribe") || url.pathname.includes("/api/manage");
  
  if (isPost && isSubscribeOrManage) {
    const ip = request.headers.get("CF-Connecting-IP") || "local-ip";
    const now = Date.now();
    
    if (!rateLimitMap.has(ip)) {
      rateLimitMap.set(ip, []);
    }
    
    const timestamps = rateLimitMap.get(ip).filter(t => now - t < LIMIT_WINDOW);
    timestamps.push(now);
    rateLimitMap.set(ip, timestamps);
    
    if (timestamps.length > MAX_REQUESTS) {
      return new Response(JSON.stringify({ error: "Too many requests. Please wait a moment before trying again." }), {
        status: 429,
        headers: {
          ...Object.fromEntries(headers.entries()),
          "Content-Type": "application/json"
        }
      });
    }
  }

  // Execute the route handler
  try {
    const response = await next();
    
    // Create copy of response to append headers safely
    const newResponse = new Response(response.body, response);
    for (const [key, value] of headers.entries()) {
      newResponse.headers.set(key, value);
    }
    return newResponse;
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), {
      status: 500,
      headers: {
        ...Object.fromEntries(headers.entries()),
        "Content-Type": "application/json"
      }
    });
  }
}
