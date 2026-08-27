const MODEL = "qwen/qwen3.6-27b";

const FREE_SCAN_LIMIT = 3;

const RATE_LIMIT_WINDOW =
    24 * 60 * 60 * 1000;

const DEFAULT_ORIGIN =
    "https://trace.kesug.com";


export default {

    async fetch(request, env) {

        const url =
            new URL(request.url);


        // CORS

        if (request.method === "OPTIONS") {

            return new Response(null, {
                status: 204,
                headers: corsHeaders(env)
            });

        }


        // Health check

        if (
            url.pathname === "/" &&
            request.method === "GET"
        ) {

            return json({

                success: true,

                service: "trace.",

                status: "online"

            }, 200, env);

        }


        // Owner unlock

        if (
            url.pathname === "/unlock" &&
            request.method === "POST"
        ) {

            return unlock(
                request,
                env
            );

        }


        // Nutrition analysis

        if (
            url.pathname === "/analyze" &&
            request.method === "POST"
        ) {

            return analyze(
                request,
                env
            );

        }


        return json({

            success: false,

            error:
                "Endpoint not found."

        }, 404, env);

    }

};


/* =========================================================
   CORS
========================================================= */

function corsHeaders(env) {

    return {

        "Access-Control-Allow-Origin":
            env.ALLOWED_ORIGIN ||
            DEFAULT_ORIGIN,

        "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type, X-Trace-Owner-Token",

        "Access-Control-Max-Age":
            "86400"

    };

}


/* =========================================================
   JSON RESPONSE
========================================================= */

function json(
    data,
    status = 200,
    env
) {

    return new Response(

        JSON.stringify(data),

        {

            status: status,

            headers: {

                "Content-Type":
                    "application/json; charset=utf-8",

                ...corsHeaders(env)

            }

        }

    );

}


/* =========================================================
   ANALYZE
========================================================= */

async function analyze(
    request,
    env
) {

    const contentType =
        request.headers.get(
            "content-type"
        ) || "";


    if (
        !contentType
            .toLowerCase()
            .includes(
                "multipart/form-data"
            )
    ) {

        return json({

            success: false,

            error:
                "Request must use multipart/form-data."

        }, 400, env);

    }


    // -----------------------------------------------------
    // Owner token
    // -----------------------------------------------------

    const ownerToken =
        request.headers.get(
            "X-Trace-Owner-Token"
        );


    const ownerMode =
        await verifyOwnerToken(
            ownerToken,
            env
        );


    // -----------------------------------------------------
    // User IP
    // -----------------------------------------------------

    const ip =
        request.headers.get(
            "CF-Connecting-IP"
        ) ||

        request.headers.get(
            "X-Forwarded-For"
        ) ||

        "unknown";


    // -----------------------------------------------------
    // 3 scan limit
    // -----------------------------------------------------

    if (!ownerMode) {

        if (!env.RATE_LIMIT) {

            console.error(
                "RATE_LIMIT KV binding missing."
            );

            return json({

                success: false,

                error:
                    "Rate-limit storage is not configured."

            }, 500, env);

        }


        const rateResult =
            await checkRateLimit(
                ip,
                env
            );


        if (!rateResult.allowed) {

            return json({

                success: false,

                error:
                    "You have used all 3 free scans for today.",

                remaining_scans: 0

            }, 429, env);

        }

    }


    // -----------------------------------------------------
    // Read image
    // -----------------------------------------------------

    let formData;


    try {

        formData =
            await request.formData();

    } catch (error) {

        console.error(
            "FormData error:",
            error
        );

        return json({

            success: false,

            error:
                "Could not read uploaded data."

        }, 400, env);

    }


    const image =
        formData.get("image");


    if (!(image instanceof File)) {

        return json({

            success: false,

            error:
                "No image was uploaded."

        }, 400, env);

    }


    // -----------------------------------------------------
    // Image size
    // -----------------------------------------------------

    const MAX_SIZE =
        8 * 1024 * 1024;


    if (image.size > MAX_SIZE) {

        return json({

            success: false,

            error:
                "Image is too large. Maximum size is 8 MB."

        }, 400, env);

    }


    // -----------------------------------------------------
    // Image type
    // -----------------------------------------------------

    const allowedTypes = [

        "image/jpeg",

        "image/png",

        "image/webp"

    ];


    if (
        !allowedTypes.includes(
            image.type
        )
    ) {

        return json({

            success: false,

            error:
                "Only JPG, PNG and WebP images are supported."

        }, 400, env);

    }


    // -----------------------------------------------------
    // Groq key check
    // -----------------------------------------------------

    if (!env.GROQ_API_KEY) {

        console.error(
            "GROQ_API_KEY secret is missing."
        );

        return json({

            success: false,

            error:
                "AI service is not configured."

        }, 500, env);

    }


    // -----------------------------------------------------
    // Convert image to base64
    // -----------------------------------------------------

    const imageBuffer =
        await image.arrayBuffer();


    const base64 =
        arrayBufferToBase64(
            imageBuffer
        );


    const imageDataUrl =
        `data:${image.type};base64,${base64}`;


    // -----------------------------------------------------
    // Language
    // -----------------------------------------------------

    const language =
        formData.get("language") === "hi"
            ? "hi"
            : "en";


    // -----------------------------------------------------
    // AI prompt
    // -----------------------------------------------------

    const prompt = `

You are the nutrition-label analysis engine for trace.

Analyze ONLY information actually visible in the uploaded
food packaging image.

Never invent missing nutrition values.

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
  "good": [],
  "watch": [],
  "ayurveda": {
    "elements": [],
    "perspective": ""
  },
  "confidence": "high"
}

Rules:

1. Only use information visible in the image.
2. Missing values MUST be null.
3. Never guess nutrition values.
4. Preserve label units where possible.
5. Do not make medical diagnoses.
6. Do not automatically call unfamiliar ingredients harmful.
7. Report serving size accurately.
8. Report servings per package when visible.
9. ingredients must contain the visible ingredient list.
10. notable_ingredients should contain useful visible ingredients.
11. allergens should contain only clearly identifiable allergens.
12. good should contain short factual positive observations.
13. watch should contain short factual things worth noticing.
14. Do not call food universally healthy or unhealthy.
15. Ayurveda must be a general traditional perspective only.
16. Do not diagnose doshas or claim treatment.
17. confidence must be high, medium, or low.
18. Use ${
    language === "hi"
        ? "Hindi"
        : "English"
} for good, watch and Ayurveda text.
19. Keep explanations concise.

Do not return markdown.
Do not return explanations outside the JSON.

`;


    // -----------------------------------------------------
    // Groq request
    // -----------------------------------------------------

    let groqResponse;


    try {

        groqResponse =
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

                        max_completion_tokens:
                            1800,

                        response_format: {

                            type:
                                "json_object"

                        },

                        messages: [

                            {

                                role:
                                    "system",

                                content:
                                    "Extract nutrition labels accurately. Never invent missing values."

                            },

                            {

                                role:
                                    "user",

                                content: [

                                    {

                                        type:
                                            "text",

                                        text:
                                            prompt

                                    },

                                    {

                                        type:
                                            "image_url",

                                        image_url: {

                                            url:
                                                imageDataUrl

                                        }

                                    }

                                ]

                            }

                        ]

                    })

                }

            );

    } catch (error) {

        console.error(
            "Groq network error:",
            error
        );

        return json({

            success: false,

            error:
                "Could not connect to the AI service."

        }, 502, env);

    }


    // -----------------------------------------------------
    // Groq error
    // -----------------------------------------------------

    if (!groqResponse.ok) {

        const errorText =
            await groqResponse.text();


        console.error(

            "Groq API error:",

            groqResponse.status,

            errorText

        );


        return json({

            success: false,

            error:
                "The AI service could not process the image."

        }, 502, env);

    }


    // -----------------------------------------------------
    // Read Groq response
    // -----------------------------------------------------

    let groqData;


    try {

        groqData =
            await groqResponse.json();

    } catch (error) {

        console.error(
            "Groq JSON error:",
            error
        );

        return json({

            success: false,

            error:
                "The AI returned an unreadable response."

        }, 502, env);

    }


    const content =
        groqData
            ?.choices?.[0]
            ?.message?.content;


    if (!content) {

        return json({

            success: false,

            error:
                "The AI returned no usable result."

        }, 502, env);

    }


    let nutrition;


    try {

        nutrition =
            typeof content === "string"

                ? JSON.parse(content)

                : content;

    } catch (error) {

        console.error(
            "AI parse error:",
            content
        );

        return json({

            success: false,

            error:
                "The AI returned invalid nutrition data."

        }, 502, env);

    }


    // -----------------------------------------------------
    // Score
    // -----------------------------------------------------

    nutrition.score =
        calculateScore(
            nutrition
        );


    // -----------------------------------------------------
    // Consume scan only after success
    // -----------------------------------------------------

    let remainingScans = null;


    if (!ownerMode) {

        remainingScans =
            await consumeScan(
                ip,
                env
            );

    }


    // -----------------------------------------------------
    // Final response
    // -----------------------------------------------------

    return json({

        success: true,

        owner_mode:
            ownerMode,

        remaining_scans:
            remainingScans,

        data:
            nutrition,

        warning:
            language === "hi"

                ? "यह विश्लेषण प्रोडक्ट लेबल पर दिखाई देने वाली जानकारी पर आधारित है और केवल जानकारी के लिए है। सबसे सही जानकारी के लिए असली पैकेजिंग देखें।"

                : "This analysis is based on information visible on the product label and is intended for informational purposes only. Always check the actual packaging for the most accurate information."

    }, 200, env);

        }
/* =========================================================
   NUTRITION SCORE
========================================================= */

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

    if (
        saturatedFat !== null &&
        saturatedFat > 5
    ) {

        score -= 1;

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


/* =========================================================
   RATE LIMIT
========================================================= */

async function checkRateLimit(
    ip,
    env
) {

    const key =
        `scan:${ip}`;


    const existing =
        await env.RATE_LIMIT.get(
            key
        );


    if (!existing) {

        return {

            allowed: true,

            scans: 0

        };

    }


    let data;


    try {

        data =
            JSON.parse(existing);

    }

    catch {

        await env.RATE_LIMIT.delete(
            key
        );

        return {

            allowed: true,

            scans: 0

        };

    }


    if (
        Date.now() -
        data.created >
        RATE_LIMIT_WINDOW
    ) {

        await env.RATE_LIMIT.delete(
            key
        );

        return {

            allowed: true,

            scans: 0

        };

    }


    return {

        allowed:
            data.scans <
            FREE_SCAN_LIMIT,

        scans:
            data.scans

    };

}


/* =========================================================
   CONSUME SCAN
========================================================= */

async function consumeScan(
    ip,
    env
) {

    const key =
        `scan:${ip}`;


    const existing =
        await env.RATE_LIMIT.get(
            key
        );


    let data;


    if (!existing) {

        data = {

            created:
                Date.now(),

            scans:
                1

        };

    }

    else {

        try {

            data =
                JSON.parse(
                    existing
                );

            data.scans++;

        }

        catch {

            data = {

                created:
                    Date.now(),

                scans:
                    1

            };

        }

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

        FREE_SCAN_LIMIT -
        data.scans

    );

}


/* =========================================================
   OWNER UNLOCK
========================================================= */

async function unlock(
    request,
    env
) {

    if (!env.OWNER_CODE) {

        return json({

            success: false,

            error:
                "Owner code is not configured."

        }, 500, env);

    }


    let body;


    try {

        body =
            await request.json();

    }

    catch {

        return json({

            success: false,

            error:
                "Invalid request."

        }, 400, env);

    }


    const code =
        typeof body?.code === "string"

            ? body.code

            : "";


    if (

        !code ||

        !timingSafeEqual(

            code,

            env.OWNER_CODE

        )

    ) {

        return json({

            success: false,

            error:
                "Invalid code."

        }, 401, env);

    }


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

            JSON.stringify(
                payload
            )

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

    }, 200, env);

}


/* =========================================================
   VERIFY OWNER TOKEN
========================================================= */

async function verifyOwnerToken(
    token,
    env
) {

    if (

        !token ||

        !env.OWNER_CODE ||

        !token.includes(".")

    ) {

        return false;

    }


    const parts =
        token.split(".");


    if (
        parts.length !== 2
    ) {

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

                base64urlDecode(
                    encoded
                )

            );

    }

    catch {

        return false;

    }


    if (
        payload.owner !== true
    ) {

        return false;

    }


    if (

        typeof payload.expires !==
        "number" ||

        payload.expires <
        Date.now()

    ) {

        return false;

    }


    return true;

}


/* =========================================================
   SIGN TOKEN
========================================================= */

async function sign(
    text,
    secret
) {

    const encoder =
        new TextEncoder();


    const key =
        await crypto.subtle.importKey(

            "raw",

            encoder.encode(
                secret
            ),

            {

                name:
                    "HMAC",

                hash:
                    "SHA-256"

            },

            false,

            ["sign"]

        );


    const signature =
        await crypto.subtle.sign(

            "HMAC",

            key,

            encoder.encode(
                text
            )

        );


    return arrayBufferToBase64url(
        signature
    );

}


/* =========================================================
   NUMBER HELPER
========================================================= */

function number(value) {

    if (

        value === null ||

        value === undefined ||

        value === ""

    ) {

        return null;

    }


    if (
        typeof value === "number"
    ) {

        return Number.isFinite(value)
            ? value
            : null;

    }


    const match =
        String(value)
            .replace(/,/g, "")
            .match(
                /-?\d+(?:\.\d+)?/
            );


    if (!match) {

        return null;

    }


    const n =
        Number(match[0]);


    return Number.isFinite(n)
        ? n
        : null;

}


/* =========================================================
   BASE64
========================================================= */

function arrayBufferToBase64(
    buffer
) {

    let binary = "";


    const bytes =
        new Uint8Array(
            buffer
        );


    const chunkSize =
        0x8000;


    for (

        let i = 0;

        i < bytes.length;

        i += chunkSize

    ) {

        binary +=
            String.fromCharCode(

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


/* =========================================================
   BASE64 URL
========================================================= */

function arrayBufferToBase64url(
    buffer
) {

    return arrayBufferToBase64(
        buffer
    )

        .replace(
            /\+/g,
            "-"
        )

        .replace(
            /\//g,
            "_"
        )

        .replace(
            /=/g,
            ""
        );

}


function base64urlEncode(
    text
) {

    return btoa(text)

        .replace(
            /\+/g,
            "-"
        )

        .replace(
            /\//g,
            "_"
        )

        .replace(
            /=/g,
            ""
        );

}


function base64urlDecode(
    text
) {

    let base64 =
        text

            .replace(
                /-/g,
                "+"
            )

            .replace(
                /_/g,
                "/"
            );


    while (
        base64.length % 4 !== 0
    ) {

        base64 += "=";

    }


    return atob(base64);

}


/* =========================================================
   TIMING SAFE STRING COMPARISON
========================================================= */

function timingSafeEqual(
    a,
    b
) {

    if (

        typeof a !== "string" ||

        typeof b !== "string" ||

        a.length !== b.length

    ) {

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


    return result === 0;

        }
