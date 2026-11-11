// Edited GiB text must denote exact safe integer bytes. Stored bytes bypass this display parser.
export function serviceQuotaBytes(text: string): number | undefined {
    return scaledServiceBytes(text, 1073741824n);
}

// Edited Mbps text has the same exact-byte contract; untouched stored rates
// never pass through display conversion. Keep the quota caller's behavior.
export function serviceRateBytes(text: string): number | undefined {
    return text.trim() === text ? scaledServiceBytes(text, 125000n) : undefined;
}

function scaledServiceBytes(text: string, scale: bigint): number | undefined {
    // A paste-size resource guard, not a quota/rate maximum. Keep oversized
    // edits pending rather than spending unbounded work on BigInt parsing.
    if (text.length > 4096)
        return undefined;
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(text);
    if (!match)
        return undefined;
    const fraction = match[3] ?? match[4] ?? "";
    const digits = ((match[2] ?? "") + fraction).replace(/^0+/, "");
    if (!digits)
        return 0;
    if (match[1] === "-")
        return undefined;
    // Normalize and bound the exponent lexically before numeric conversion.
    // A nonzero coefficient of <=4096 digits cannot yield a safe integer with
    // an exponent outside this range. Zero was handled without conversion.
    const exponentText = (match[5] ?? "0").replace(/^([+-]?)0+/, "$1") || "0";
    if (exponentText.replace(/^[+-]/, "").length > 6)
        return undefined;
    const exponent = Number(exponentText === "+" || exponentText === "-" ? "0" : exponentText);
    try {
        const product = (BigInt(digits) * scale).toString();
        const significant = product.replace(/0+$/, "");
        const shift = exponent - fraction.length + product.length - significant.length;
        if (shift < 0 || significant.length + shift > 16)
            return undefined;
        const integer = BigInt(significant + "0".repeat(shift));
        return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : undefined;
    }
    catch {
        return undefined;
    }
}
