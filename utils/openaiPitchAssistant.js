const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const PITCH_TEXT_MAX_LENGTH = 500;

const SYSTEM_PROMPT = `Du er en erfaren norsk tekstforfatter som hjelper startup-gründere å skrive pitch-tekster som får folk i nettverket deres lyst til å investere.
Du får to tekstfelt gründeren har skrevet selv: "Hva selskapet tilbyr" og "Hva pengene skal brukes til". Leserne er venner, familie og bekjente som har fått en personlig invitasjon.

"what_offers": 2–3 korte setninger. Start med hva selskapet gjør og for hvem, så hvilket problem det løser eller hvorfor det betyr noe. Skriv aktivt og konkret, med varme og energi, som en gründer som tror på det de bygger. Bruk "vi".
"use_of_funds": 2–4 punkter, ett per linje, hver linje starter med "- ". Hvert punkt er konkret og kort (helst under 60 tegn) og sier hva pengene gjør. Del gjerne opp en lang setning i flere punkter.

Behold alle faktiske opplysninger. Ikke finn på funksjoner, tall, kunder, målgrupper, planer, resultater eller påstander som ikke står i originalteksten. Ikke lov avkastning eller verdiøkning, og ikke bruk tomme ord som "innovativ", "banebrytende" eller "revolusjonerende".
Er originalteksten kort, skal forslaget også være kort.
Hvert felt skal være maks ${PITCH_TEXT_MAX_LENGTH} tegn.
Svar KUN med gyldig JSON på nøyaktig dette formatet, uten noe annen tekst før eller etter: {"what_offers": "...", "use_of_funds": "..."}`;

export async function improveStartupPitchText({ whatOffers, useOfFunds }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return null;
    }

    const userPrompt = JSON.stringify({
        what_offers: whatOffers || "",
        use_of_funds: useOfFunds || ""
    });

    const response = await fetchWithTimeout(OPENAI_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt }
            ],
            response_format: { type: "json_object" },
            // Low: the job is rewording what was written, not adding to it;
            // a little room for a livelier tone than a literal rewrite.
            temperature: 0.35,
            max_tokens: 600
        })
    }, { timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 15000) });

    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Tekstforbedringen er midlertidig utilgjengelig (${response.status}).`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error("OpenAI returnerte ikke noe innhold.");
    }

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error("Kunne ikke tolke svaret fra OpenAI.");
    }

    return {
        whatOffers: String(parsed.what_offers || "").trim().slice(0, PITCH_TEXT_MAX_LENGTH),
        useOfFunds: String(parsed.use_of_funds || "").trim().slice(0, PITCH_TEXT_MAX_LENGTH)
    };
}
import { fetchWithTimeout } from "./fetchWithTimeout.js";
