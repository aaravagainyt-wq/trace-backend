// ============================================================
// trace. — AI Nutrition Scanner Backend
// Cloudflare Worker
// ============================================================
//
// Routes:
//
// POST /analyze
//     Upload image as multipart/form-data
//     Field name: "image"
//
// POST /unlock
//     JSON: { "code": "YOUR_OWNER_CODE" }
//
// GET /
//     Health check
//
// Cloudflare secrets required:
//
// GROQ_API_KEY
// OWNER_CODE
//
// ============================================================

const MODEL = "qwen/qwen3.6-27b";

const FREE_SCAN_LIMIT = 3;

// 24 hours
const RATE_LIMIT_WINDOW = 24 * 60 * 60 * 1000;

// Change this to your actual InfinityFree domain.
const ALLOWED_ORIGIN = "https://YOUR-SITE.infinityfreeapp.com";


// ============================================================
// MAIN
// ============================================================

export default {
    async fetch(request, env) {

        const url = new URL(request.url);

        // ----------------------------------------------------
        // CORS
        // ----------------------------------------------------

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        // ----------------------------------------------------
        // Health check
        // ----------------------------------------------------

        if (url.pathname === "/" && request.method === "GET") {

            return json({
                success: true,
                service: "trace.",
                status: "online"
            });
        }

        // ----------------------------------------------------
        // Owner unlock
        // ----------------------------------------------------

        if (
            url.pathname === "/unlock" &&
            request.method === "POST"
        ) {
            return unlock(request, env);
        }

        // ----------------------------------------------------
        // Nutrition analysis
        // ----------------------------------------------------

        if (
            url.pathname === "/analyze" &&
            request.method === "POST"
        ) {
            return analyze(request, env);
        }

        return json(
            {
                success: false,
                error: "Endpoint not found."
            },
            404
        );
    }
};


// ============================================================
// ANALYZE
// ============================================================

async function analyze(request, env) {

    // --------------------------------------------------------
    // Basic content check
    // --------------------------------------------------------

    const contentType =
        request.headers.get("content-type") || "";

    if (!contentType.includes("multipart/form-data")) {
        return json(
            {
                success: false,
                error: "Request must use multipart/form-data."
            },
            400
        );
    }

    // --------------------------------------------------------
    // Check owner token
    // --------------------------------------------------------

    const ownerToken =
        request.headers.get("X-Trace-Owner-Token");

    const ownerMode =
        await verifyOwnerToken(ownerToken, env);

    // --------------------------------------------------------
    // Rate limit normal users
    // --------------------------------------------------------

    const ip =
        request.headers.get("CF-Connecting-IP") ||
        request.headers.get("X-Forwarded-For") ||
        "unknown";

    if (!ownerMode) {

        const rateResult =
            await checkRateLimit(ip, env);

        if (!rateResult.allowed) {

            return json(
                {
                    success: false,
                    error:
                        "You have used all 3 free scans for today.",
                    remaining_scans: 0
                },
                429
            );
        }
    }

    // --------------------------------------------------------
    // Get uploaded image
    // --------------------------------------------------------

    let formData;

    try {
        formData = await request.formData();
    } catch {

        return json(
            {
                success: false,
                error: "Could not read uploaded data."
            },
            400
        );
    }

    const image =
        formData.get("image");

    if (!(image instanceof File)) {

        return json(
            {
                success: false,
                error: "No image was uploaded."
            },
            400
        );
    }

    // --------------------------------------------------------
    // File size
    // --------------------------------------------------------

    const MAX_SIZE = 8 * 1024 * 1024;

    if (image.size > MAX_SIZE) {

        return json(
            {
                success: false,
                error:
                    "Image is too large. Maximum size is 8 MB."
            },
            400
        );
    }

    // --------------------------------------------------------
    // MIME validation
    // --------------------------------------------------------

    const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/webp"
    ];

    if (!allowedTypes.includes(image.type)) {

        return json(
            {
                success: false,
                error:
                    "Only JPG, PNG and WebP images are supported."
            },
            400
        );
    }

    // --------------------------------------------------------
    // Convert image to base64
    // --------------------------------------------------------

    const imageBuffer =
        await image.arrayBuffer();

    const base64 =
        arrayBufferToBase64(imageBuffer);

    const imageDataUrl =
        `data:${image.type};base64,${base64}`;

    // --------------------------------------------------------
    // Prompt
    // --------------------------------------------------------

    const prompt = `
You are the nutrition-label extraction engine for trace.

Analyze ONLY information that is actually visible in the
uploaded food packaging image.

Your job is to extract nutrition facts and ingredients.

NEVER invent missing values.

Return ONLY valid JSON.

Use this exact structure:

{
  "product_name": null,
  "serving_size": null,
  "servings_per_package": null,
  "calories": null,
  "total_fat": null,
  "saturated_fat": null,
  "trans_fat": null,
  "carbohydrates": null,
  "total_sugar": null,
  "added_sugar": null,
  "protein": null,
  "fiber": null,
  "sodium": null,
  "ingredients": [],
  "notable_ingredients": [],
  "allergens": [],
  "confidence": "high"
}

Rules:

1. Only use information visible in the image.
2. Missing values MUST be null.
3. Never guess nutrition values.
4. Preserve the label's units where possible.
5. Do not make medical diagnoses.
6. Do not automatically call unfamiliar ingredients harmful.
7. Report serving size accurately.
8. Report servings per package when visible.
9. ingredients should contain the visible ingredient list.
10. notable_ingredients should contain relevant visible ingredients.
11. allergens should contain only clearly identifiable allergens.
12. confidence must be high, medium, or low.

Do not return markdown.
Do not return explanations outside the JSON.
`;

    // --------------------------------------------------------
    // Groq request
    // --------------------------------------------------------

    const groqResponse =
        await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",

                headers: {
                    "Authorization":
                        `Bearer ${env.GROQ_API_KEY}`,

                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({

                    model: MODEL,

                    temperature: 0,

                    max_completion_tokens: 1500,

                    response_format: {
                        type: "json_object"
                    },

                    messages: [

                        {
                            role: "system",

                            content:
                                "Extract nutrition labels accurately. " +
                                "Never invent missing values."
                        },

                        {
                            role: "user",

                            content: [

                                {
                                    type: "text",
                                    text: prompt
                                },

                                {
                                    type: "image_url",

                                    image_url: {
                                        url: imageDataUrl
                                    }
                                }

                            ]
                        }

                    ]
                })
            }
        );

    // --------------------------------------------------------
    // Groq error
    // --------------------------------------------------------

    if (!groqResponse.ok) {

        console.error(
            "Groq error:",
            await groqResponse.text()
        );

        return json(
            {
                success: false,
                error:
                    "The AI service could not process the image."
            },
            502
        );
    }

    // --------------------------------------------------------
    // Read Groq response
    // --------------------------------------------------------

    const groqData =
        await groqResponse.json();

    const content =
        groqData?.choices?.[0]?.message?.content;

    if (!content) {

        return json(
            {
                success: false,
                error:
                    "The AI returned no usable result."
            },
            502
        );
    }

    // --------------------------------------------------------
    // Parse AI JSON
    // --------------------------------------------------------

    let nutrition;

    try {

        nutrition =
            typeof content === "string"
                ? JSON.parse(content)
                : content;

    } catch {

        return json(
            {
                success: false,
                error:
                    "The AI returned invalid nutrition data."
            },
            502
        );
    }

    // --------------------------------------------------------
    // Calculate score ourselves
    // --------------------------------------------------------

    const score =
        calculateScore(nutrition);

    nutrition.score = score;

    // --------------------------------------------------------
    // Consume scan AFTER successful AI processing
    // --------------------------------------------------------

    let remainingScans = null;

    if (!ownerMode) {

        remainingScans =
            await consumeScan(ip, env);
    }

    // --------------------------------------------------------
    // Final response
    // --------------------------------------------------------

    return json({

        success: true,

        owner_mode: ownerMode,

        remaining_scans:
            remainingScans,

        data: nutrition,

        warning:
            "This analysis is based on the information visible " +
            "on the product label and is intended for informational " +
            "purposes only. Always check the actual packaging for " +
            "the most accurate information."
    });
}


// ============================================================
// NUTRITION SCORE
// ============================================================

function calculateScore(data) {

    let score = 5;

    const protein =
        number(data.protein);

    const fiber =
        number(data.fiber);

    const addedSugar =
        number(data.added_sugar);

    const saturatedFat =
        number(data.saturated_fat);

    const sodium =
        number(data.sodium);

    // Protein

    if (protein !== null) {

        if (protein >= 10) {
            score += 1;
        }

        else if (protein >= 5) {
            score += 0.5;
        }
    }

    // Fiber

    if (fiber !== null) {

        if (fiber >= 5) {
            score += 1;
        }

        else if (fiber >= 3) {
            score += 0.5;
        }
    }

    // Added sugar

    if (addedSugar !== null) {

        if (addedSugar > 15) {
            score -= 1.5;
        }

        else if (addedSugar > 8) {
            score -= 0.75;
        }
    }

    // Saturated fat

    if (saturatedFat !== null) {

        if (saturatedFat > 5) {
            score -= 1;
        }
    }

    // Sodium

    if (sodium !== null) {

        if (sodium > 600) {
            score -= 1;
        }

        else if (sodium > 300) {
            score -= 0.5;
        }
    }

    return Math.max(
        0,
        Math.min(
            10,
            Math.round(score * 10) / 10
        )
    );
}


// ============================================================
// RATE LIMIT
// ============================================================
//
// Uses Cloudflare KV.
//
// Create a KV namespace called:
//
// TRACE_LIMITS
//
// Then bind it to the Worker as:
//
// RATE_LIMIT
//
// ============================================================

async function checkRateLimit(ip, env) {

    const key =
        `scan:${ip}`;

    const existing =
        await env.RATE_LIMIT.get(key);

    if (!existing) {

        return {
            allowed: true,
            scans: 0
        };
    }

    const data =
        JSON.parse(existing);

    if (
        Date.now() -
        data.created >
        RATE_LIMIT_WINDOW
    ) {

        await env.RATE_LIMIT.delete(key);

        return {
            allowed: true,
            scans: 0
        };
    }

    return {
        allowed:
            data.scans < FREE_SCAN_LIMIT,

        scans:
            data.scans
    };
}


async function consumeScan(ip, env) {

    const key =
        `scan:${ip}`;

    const existing =
        await env.RATE_LIMIT.get(key);

    let data;

    if (!existing) {

        data = {
            created: Date.now(),
            scans: 1
        };

    } else {

        data =
            JSON.parse(existing);

        data.scans++;
    }

    await env.RATE_LIMIT.put(
        key,
        JSON.stringify(data),
        {
            expirationTtl:
                24 * 60 * 60
        }
    );

    return Math.max(
        0,
        FREE_SCAN_LIMIT - data.scans
    );
}


// ============================================================
// OWNER UNLOCK
// ============================================================

async function unlock(request, env) {

    let body;

    try {
        body =
            await request.json();
    } catch {

        return json(
            {
                success: false,
                error: "Invalid request."
            },
            400
        );
    }

    const code =
        body?.code || "";

    if (
        !code ||
        !env.OWNER_CODE ||
        !timingSafeEqual(
            code,
            env.OWNER_CODE
        )
    ) {

        return json(
            {
                success: false,
                error: "Invalid code."
            },
            401
        );
    }

    // --------------------------------------------------------
    // Create temporary signed token
    // --------------------------------------------------------

    const payload = {

        owner: true,

        expires:
            Date.now() +
            24 * 60 * 60 * 1000,

        random:
            crypto.randomUUID()
    };

    const encoded =
        base64urlEncode(
            JSON.stringify(payload)
        );

    const signature =
        await sign(
            encoded,
            env.OWNER_CODE
        );

    const token =
        `${encoded}.${signature}`;

    return json({

        success: true,

        token: token,

        expires:
            payload.expires
    });
}


// ============================================================
// VERIFY OWNER TOKEN
// ============================================================

async function verifyOwnerToken(
    token,
    env
) {

    if (
        !token ||
        !token.includes(".")
    ) {
        return false;
    }

    const parts =
        token.split(".");

    if (parts.length !== 2) {
        return false;
    }

    const encoded =
        parts[0];

    const signature =
        parts[1];

    const expected =
        await sign(
            encoded,
            env.OWNER_CODE
        );

    if (
        !timingSafeEqual(
            signature,
            expected
        )
    ) {
        return false;
    }

    let payload;

    try {

        payload =
            JSON.parse(
                base64urlDecode(encoded)
            );

    } catch {

        return false;
    }

    if (
        payload.owner !== true
    ) {
        return false;
    }

    if (
        payload.expires < Date.now()
    ) {
        return false;
    }

    return true;
}


// ============================================================
// SIGN TOKEN
// ============================================================

async function sign(
    text,
    secret
) {

    const encoder =
        new TextEncoder();

    const key =
        await crypto.subtle.importKey(
            "raw",
            encoder.encode(secret),
            {
                name: "HMAC",
                hash: "SHA-256"
            },
            false,
            ["sign"]
        );

    const signature =
        await crypto.subtle.sign(
            "HMAC",
            key,
            encoder.encode(text)
        );

    return arrayBufferToBase64url(
        signature
    );
}


// ============================================================
// HELPERS
// ============================================================

function number(value) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    const n =
        Number(value);

    return Number.isFinite(n)
        ? n
        : null;
}


function arrayBufferToBase64(buffer) {

    let binary = "";

    const bytes =
        new Uint8Array(buffer);

    const chunkSize = 0x8000;

    for (
        let i = 0;
        i < bytes.length;
        i += chunkSize
    ) {

        binary += String.fromCharCode(
            ...bytes.subarray(
                i,
                Math.min(
                    i + chunkSize,
                    bytes.length
                )
            )
        );
    }

    return btoa(binary);
}


function arrayBufferToBase64url(buffer) {

    return arrayBufferToBase64(buffer)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}


function base64urlEncode(text) {

    return btoa(text)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}


function base64urlDecode(text) {

    let base64 =
        text
            .replace(/-/g, "+")
            .replace(/_/g, "/");

    while (
        base64.length % 4 !== 0
    ) {
        base64 += "=";
    }

    return atob(base64);
}


function timingSafeEqual(a, b) {

    if (a.length !== b.length) {
        return false;
    }

    let result = 0;

    for (
        let i = 0;
        i < a.length;
        i++
    ) {
        result |=
            a.charCodeAt(i) ^
            b.charCodeAt(i);
    }

    return resu
lt === 0;
}

function corsHeaders() {

    return {

        "Access-Control-Allow-Origin":
            ALLOWED_ORIGIN,

        "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type, X-Trace-Owner-Token",

        "Access-Control-Max-Age":
            "86400"
    };
}


function json(
    data,
    status = 200
) {

    return new Response(
        JSON.stringify(data),
        {
            status,

            headers: {
                "Content-Type":
                    "application/json",

                ...corsHeaders()
            }
        }
    );
}
