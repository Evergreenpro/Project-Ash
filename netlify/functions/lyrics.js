// Tries materiaq first, then spotifyplus-api, and picks the best result:
// word-synced (karaoke) beats line-synced beats plain static text, and
// within each tier materiaq wins ties since it was checked first.

const MATERIAQ_BASE = "https://lyrics.materiaq.org/api/v1/lyrics/sp";
const SPOTIFYPLUS_BASE = "https://spotifyplus-api.devon-shoutz.workers.dev";

// materiaq's shape: { type: 'word'|'line'|'static', parts: [{ content: [...] }] }
// (times in ms). Mapped here into the same { Type, Content } shape spotifyplus-api
// already returns natively, so the frontend's parseLyrics() doesn't need to care
// which source it came from.
function normalizeMateriaq(lyricsObj) {
    if (!lyricsObj) return null;
    const type = lyricsObj.type;

    if (type === 'word') {
        // Best-effort mapping: each "part" = one line, each part's "content"
        // entries = the timed words in that line. Unverified against a real
        // word-synced response — adjust here if materiaq's actual shape differs.
        const content = (lyricsObj.parts || []).map(part => {
            const words = part.content || [];
            if (!words.length) return null;
            return {
                Type: 'Vocal',
                Lead: {
                    StartTime: words[0].start / 1000,
                    EndTime: words[words.length - 1].end / 1000,
                    Syllables: words.map(w => ({
                        StartTime: w.start / 1000,
                        EndTime: w.end / 1000,
                        Text: w.text,
                        IsPartOfWord: false
                    }))
                }
            };
        }).filter(Boolean);

        if (!content.length) return null;
        return { Type: 'Syllable', Content: content };
    }

    if (type === 'line') {
        const content = (lyricsObj.parts || [])
            .flatMap(part => part.content || [])
            .map(c => ({
                Type: 'Vocal',
                StartTime: c.start / 1000,
                EndTime: c.end / 1000,
                Text: c.text
            }));

        if (!content.length) return null;
        return { Type: 'Line', Content: content };
    }

    // 'static' or anything unrecognized: just grab whatever text is there.
    const lines = (lyricsObj.parts || [])
        .flatMap(part => part.content || [])
        .map(c => ({ Text: c.text }));

    if (!lines.length) return null;
    return { Type: 'Static', Lines: lines };
}

async function fetchMateriaq(trackId) {
    try {
        const res = await fetch(`${MATERIAQ_BASE}/${encodeURIComponent(trackId)}`);
        if (!res.ok) return null;
        const json = await res.json();
        if (json.status !== 'success' || !json.data?.lyrics) return null;
        return normalizeMateriaq(json.data.lyrics);
    } catch (e) {
        return null;
    }
}

async function fetchSpotifyPlus(trackId) {
    try {
        const res = await fetch(`${SPOTIFYPLUS_BASE}/api/lyrics/${encodeURIComponent(trackId)}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.error || !data.Type) return null;
        return data; // already { Type, Content } / { Type, Lines }
    } catch (e) {
        return null;
    }
}

// --- Romanization (Hindi/Devanagari + Urdu/Arabic script) ---
// Uses the same free endpoint @vitalets/google-translate-api uses, with
// dj=1 for clean JSON instead of the usual nested-array soup. With dt=rm,
// the response's "sentences" array gets one extra entry shaped like
// { src_translit: "..." } holding the romanized version of the whole input.
const NON_LATIN_SCRIPT = /[\u0900-\u097F\u0600-\u06FF\u0750-\u077F]/;
function needsRomanization(text) {
    return NON_LATIN_SCRIPT.test(text || '');
}

async function romanize(text) {
    if (!text || !text.trim()) return null;

    const attempt = async (url, method, body) => {
        try {
            const res = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
                    // Google 403s requests with no browser-like User-Agent — Node's
                    // native fetch (what Netlify Functions run on) sends none by
                    // default, which is almost certainly why this was failing.
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                body
            });
            if (!res.ok) return null;
            const data = await res.json();
            const translit = (data.sentences || [])
                .filter(s => 'src_translit' in s)
                .map(s => s.src_translit)
                .join(' ')
                .trim();
            return translit || null;
        } catch (e) {
            return null;
        }
    };

    // Primary: translate.google.com (POST, matches @vitalets/google-translate-api).
    const primary = await attempt(
        'https://translate.google.com/translate_a/single?client=at&dt=t&dt=rm&dj=1',
        'POST',
        new URLSearchParams({ sl: 'auto', tl: 'en', q: text }).toString()
    );
    if (primary) return primary;

    // Fallback: translate.googleapis.com (GET) — different domain, sometimes
    // waved through when translate.google.com blocks a datacenter IP.
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&dt=rm&dj=1&q=${encodeURIComponent(text)}`;
    return attempt(url, 'GET', undefined);
}

// Rebuilds the plain text of a syllable-synced line, honoring the same
// IsPartOfWord spacing rule the frontend uses, so we can check/romanize it
// as one string.
function syllablesToText(syllables) {
    return syllables.map((s, idx) => {
        const space = !s.IsPartOfWord && idx < syllables.length - 1 ? ' ' : '';
        return s.Text + space;
    }).join('');
}

// --- Word-level timing mapping for romanized lines (port of
// LyricsTranslationMapper.java) ---
// Romanized word count/lengths never line up 1:1 with the original
// Devanagari/Urdu syllable groups, so instead of guessing a 1:1 pairing,
// this distributes the romanized words across the ORIGINAL words'
// start/end windows proportionally by character weight — same word order
// in and out (transliteration doesn't reorder), just different lengths.

function weight(value) {
    if (!value) return 1;
    const count = (value.match(/[\p{L}\p{N}]/gu) || []).length;
    return Math.max(1, count);
}

function tokenize(line) {
    if (!line || !line.trim()) return [];
    return line.trim().split(/\s+/).filter(Boolean);
}

// Groups raw syllables back into whole words (joining consecutive
// IsPartOfWord syllables), each with its own combined start/end time.
function sourceWordsFromSyllables(syllables) {
    const words = [];
    let text = '';
    let startTime = 0, endTime = 0, hasWord = false;

    for (const syl of syllables) {
        if (!syl || syl.Text == null) continue;
        if (!hasWord) { startTime = syl.StartTime; hasWord = true; }
        text += syl.Text;
        endTime = syl.EndTime;

        if (!syl.IsPartOfWord) {
            const value = text.trim();
            if (value) words.push({ text: value, startTime, endTime });
            text = '';
            hasWord = false;
        }
    }
    if (hasWord) {
        const value = text.trim();
        if (value) words.push({ text: value, startTime, endTime });
    }
    return words;
}

function mapTranslationTokens(sourceSyllables, translatedLine) {
    const sourceWords = sourceWordsFromSyllables(sourceSyllables);
    const targetTokens = tokenize(translatedLine);
    const result = [];

    if (!sourceWords.length || !targetTokens.length) return result;

    const sourceWeight = sourceWords.reduce((sum, w) => sum + weight(w.text), 0);
    const targetWeight = targetTokens.reduce((sum, t) => sum + weight(t), 0);

    let targetOffset = 0;
    let sourceIndex = 0;
    let sourceOffset = 0;
    const sourceAssignments = [];

    // For each romanized token, find which original word its weighted
    // midpoint falls under — i.e. "this token sits about 60% of the way
    // through the line, so it belongs to whichever source word covers
    // that 60% mark."
    for (const token of targetTokens) {
        const tokenWeight = weight(token);
        const targetMidpoint = (targetOffset + tokenWeight / 2) / targetWeight;

        while (sourceIndex < sourceWords.length - 1) {
            const nextSourceOffset = sourceOffset + weight(sourceWords[sourceIndex].text);
            const sourceEnd = nextSourceOffset / sourceWeight;
            if (targetMidpoint <= sourceEnd) break;
            sourceOffset = nextSourceOffset;
            sourceIndex++;
        }

        sourceAssignments.push(sourceIndex);
        targetOffset += tokenWeight;
    }

    // Group consecutive tokens assigned to the same source word, then
    // carve that word's timing window up between them proportionally.
    let tokenIndex = 0;
    while (tokenIndex < targetTokens.length) {
        const assignedSourceIndex = sourceAssignments[tokenIndex];
        let groupEndIndex = tokenIndex + 1;
        while (groupEndIndex < targetTokens.length && sourceAssignments[groupEndIndex] === assignedSourceIndex) {
            groupEndIndex++;
        }

        const sourceWord = sourceWords[assignedSourceIndex];
        let groupWeight = 0;
        for (let i = tokenIndex; i < groupEndIndex; i++) groupWeight += weight(targetTokens[i]);

        let groupOffset = 0;
        const sourceDuration = Math.max(0, sourceWord.endTime - sourceWord.startTime);
        for (let i = tokenIndex; i < groupEndIndex; i++) {
            const token = targetTokens[i];
            const tokenWeight = weight(token);
            const startTime = sourceWord.startTime + sourceDuration * (groupOffset / groupWeight);
            groupOffset += tokenWeight;
            const endTime = sourceWord.startTime + sourceDuration * (groupOffset / groupWeight);
            result.push({ text: token, startTime, endTime });
        }

        tokenIndex = groupEndIndex;
    }

    return result;
}

// Romanizes any Devanagari/Urdu text in the chosen result, in place.
async function romanizeResult(result) {
    if (!result) return result;

    if (result.Type === 'Line') {
        await Promise.all(result.Content.map(async item => {
            if (item.Text && needsRomanization(item.Text)) {
                const r = await romanize(item.Text);
                if (r) item.Text = r;
            }
        }));
    } else if (result.Type === 'Static') {
        await Promise.all(result.Lines.map(async l => {
            if (l.Text && needsRomanization(l.Text)) {
                const r = await romanize(l.Text);
                if (r) l.Text = r;
            }
        }));
    } else if (result.Type === 'Syllable') {
        await Promise.all(result.Content.map(async item => {
            if (item.Type === 'Interlude' || !item.Lead) return;
            const original = syllablesToText(item.Lead.Syllables);
            if (needsRomanization(original)) {
                const r = await romanize(original);
                if (r) {
                    const tokens = mapTranslationTokens(item.Lead.Syllables, r);
                    if (tokens.length) {
                        item.Lead.Syllables = tokens.map(t => ({
                            StartTime: t.startTime,
                            EndTime: t.endTime,
                            Text: t.text,
                            IsPartOfWord: false
                        }));
                    }
                }
            }
        }));
    }

    return result;
}

exports.handler = async (event, context) => {
    try {
        const trackId = event.queryStringParameters?.id;

        if (!trackId) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Missing track id" })
            };
        }

        // Fetch both in parallel — we want to compare what's available anyway,
        // so there's no point waiting on materiaq before starting spotifyplus.
        const [materiaq, spotifyPlus] = await Promise.all([
            fetchMateriaq(trackId),
            fetchSpotifyPlus(trackId)
        ]);

        const candidates = [materiaq, spotifyPlus]; // materiaq checked first at every tier

        const result =
            candidates.find(l => l?.Type === 'Syllable') ||
            candidates.find(l => l?.Type === 'Line') ||
            candidates.find(l => l?.Type === 'Static') ||
            null;

        if (!result) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "No lyrics found" })
            };
        }

        await romanizeResult(result);

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=300"
            },
            body: JSON.stringify(result)
        };
    } catch (e) {
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: e.message })
        };
    }
};