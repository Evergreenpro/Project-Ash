exports.handler = async (event, context) => {
    try {
        const authHeader = Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString("base64");

        const response = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": `Basic ${authHeader}`
            },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: process.env.SPOTIFY_REFRESH_TOKEN || ""
            }).toString()
        });

        const data = await response.json();
        
        if (!response.ok) {
            return {
                statusCode: response.status,
                body: JSON.stringify({ error: data })
            };
        }

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ access_token: data.access_token })
        };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};