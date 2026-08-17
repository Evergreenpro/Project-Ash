exports.handler = async (event, context) => {
    try {
        const authHeader = Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString("base64");

        // 1. Get a fresh access token using your secret refresh token
        const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
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

        const tokenData = await tokenResponse.json();
        
        if (!tokenResponse.ok) {
            return {
                statusCode: tokenResponse.status,
                body: JSON.stringify({ error: tokenData })
            };
        }

        // 2. Fetch currently playing track right here on the server
        const playerResponse = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
            headers: { "Authorization": "Bearer " + tokenData.access_token }
        });

        if (playerResponse.status === 204 || playerResponse.status !== 200) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ is_playing: false })
            };
        }

        const d = await playerResponse.json();
        if (!d.item || !d.is_playing) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ is_playing: false })
            };
        }

        // 3. Return ONLY harmless public data to the frontend
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                is_playing: true,
                track_id: d.item.id,
                song: d.item.name,
                artist: d.item.artists.map(a => a.name).join(', '),
                album_art_url: d.item.album.images[0]?.url,
                url: d.item.external_urls.spotify,
                progress_ms: d.progress_ms,
                duration_ms: d.item.duration_ms
            })
        };

    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};