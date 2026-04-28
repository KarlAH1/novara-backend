import crypto from "crypto";

function formatDateTimeLabel(value) {
  if (!value) return "Ikke signert";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString("no-NO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildSignatureBlock(signers = []) {
  const rows = signers.map((signer) => `
      <tr>
        <td style="padding: 8px 10px; border-top: 1px solid #ddd4c7;">${escapeHtml(signer.role || "Signer")}</td>
        <td style="padding: 8px 10px; border-top: 1px solid #ddd4c7;">${escapeHtml(signer.signer_name || signer.email || "Ikke satt")}</td>
        <td style="padding: 8px 10px; border-top: 1px solid #ddd4c7;">${escapeHtml(formatDateTimeLabel(signer.signed_at))}</td>
        <td style="padding: 8px 10px; border-top: 1px solid #ddd4c7;">Raisium software</td>
      </tr>
  `).join("");

  return `
    <section style="margin-top: 28px; padding: 16px 18px; border: 1px solid #d8d0c4; border-radius: 14px; background: #f8f4ed;">
      <p style="margin: 0 0 10px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;">Signatur og bekreftelse</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #fffdf8; border: 1px solid #ddd4c7;">
        <thead>
          <tr style="background: #f1ece3;">
            <th style="padding: 8px 10px; text-align: left;">Rolle</th>
            <th style="padding: 8px 10px; text-align: left;">Signert av</th>
            <th style="padding: 8px 10px; text-align: left;">Tidspunkt</th>
            <th style="padding: 8px 10px; text-align: left;">Markering</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <p style="margin: 10px 0 0; font-size: 13px;"><strong>Bekreftet av software:</strong> Dokumentet er signert og låst i Raisium software.</p>
      <p style="margin: 6px 0 0; font-size: 13px;"><strong>Sted:</strong> Raisium software</p>
    </section>
  `;
}

export function applySignatureBlockToHtml(htmlContent = "", signers = []) {
  const signatureBlock = buildSignatureBlock(signers);
  let updatedHtml = String(htmlContent || "");

  if (/<!--\s*digital_signature_line\s*-->/i.test(updatedHtml)) {
    updatedHtml = updatedHtml.replace(/<!--\s*digital_signature_line\s*-->/gi, signatureBlock);
  } else if (!updatedHtml.includes("Bekreftet av software")) {
    updatedHtml += signatureBlock;
  }

  return updatedHtml;
}

export async function lockDocumentWithSignatures(connection, documentId) {
  const [[doc]] = await connection.query(
    `
    SELECT id, html_content
    FROM documents
    WHERE id = ?
    LIMIT 1
    `,
    [documentId]
  );

  if (!doc) {
    throw new Error("Document not found");
  }

  const [signers] = await connection.query(
    `
    SELECT ds.role, ds.email, ds.signed_at, COALESCE(u.name, ds.email) AS signer_name
    FROM document_signers ds
    LEFT JOIN users u ON u.id = ds.user_id
    WHERE ds.document_id = ?
    ORDER BY ds.id ASC
    `,
    [documentId]
  );

  const updatedHtml = applySignatureBlockToHtml(doc.html_content, signers);

  const documentHash = crypto
    .createHash("sha256")
    .update(updatedHtml)
    .digest("hex");

  await connection.query(
    `
    UPDATE documents
    SET status = 'LOCKED',
        document_hash = ?,
        locked_at = NOW(),
        html_content = ?
    WHERE id = ?
    `,
    [documentHash, updatedHtml, documentId]
  );

  return {
    documentHash,
    htmlContent: updatedHtml
  };
}
