import "server-only";

import Busboy from "busboy";

export class MultipartRequestError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MultipartRequestError";
    this.status = status;
  }
}

type MultipartLimits = {
  maxBodyBytes: number;
  maxFileBytes: number;
  maxFiles?: number;
  maxFields?: number;
  maxFieldBytes?: number;
};

export async function parseBoundedMultipartFormData(
  request: Request,
  limits: MultipartLimits,
) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new MultipartRequestError("Requesten må være multipart/form-data.", 415);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limits.maxBodyBytes) {
    throw new MultipartRequestError("Opplastingen er for stor.", 413);
  }
  if (!request.body) {
    throw new MultipartRequestError("Opplastingen mangler innhold.");
  }

  const fields: Array<[string, string]> = [];
  const files: Array<{
    fieldName: string;
    fileName: string;
    mimeType: string;
    chunks: Buffer[];
  }> = [];
  let parserError: Error | null = null;

  const parser = Busboy({
    headers: { "content-type": contentType },
    limits: {
      fileSize: limits.maxFileBytes,
      files: limits.maxFiles ?? 1,
      fields: limits.maxFields ?? 30,
      fieldSize: limits.maxFieldBytes ?? 64 * 1024,
      parts: (limits.maxFiles ?? 1) + (limits.maxFields ?? 30),
    },
  });

  parser.on("field", (name, value, info) => {
    if (info.valueTruncated && !parserError) {
      parserError = new MultipartRequestError("Et skjemafelt er for stort.", 413);
    }
    fields.push([name, value]);
  });
  parser.on("file", (fieldName, stream, info) => {
    const file = {
      fieldName,
      fileName: info.filename || "upload.bin",
      mimeType: info.mimeType || "application/octet-stream",
      chunks: [] as Buffer[],
    };
    files.push(file);
    stream.on("data", (chunk: Buffer) => file.chunks.push(Buffer.from(chunk)));
    stream.on("limit", () => {
      if (!parserError) {
        parserError = new MultipartRequestError("Filen er for stor.", 413);
      }
    });
  });
  parser.on("filesLimit", () => {
    if (!parserError) {
      parserError = new MultipartRequestError("For mange filer i opplastingen.");
    }
  });
  parser.on("fieldsLimit", () => {
    if (!parserError) {
      parserError = new MultipartRequestError("For mange skjemafelt.");
    }
  });
  parser.on("partsLimit", () => {
    if (!parserError) {
      parserError = new MultipartRequestError("For mange deler i opplastingen.");
    }
  });

  const completed = new Promise<void>((resolve, reject) => {
    parser.once("close", resolve);
    parser.once("error", reject);
  });
  const reader = request.body.getReader();
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > limits.maxBodyBytes) {
        parserError = new MultipartRequestError("Opplastingen er for stor.", 413);
        await reader.cancel();
        parser.end();
        break;
      }
      parser.write(Buffer.from(value));
    }
    if (receivedBytes <= limits.maxBodyBytes) {
      parser.end();
    }
    await completed;
  } catch (error) {
    throw error instanceof MultipartRequestError
      ? error
      : new MultipartRequestError("Kunne ikke lese opplastingen.");
  }

  if (parserError) throw parserError;

  const formData = new FormData();
  for (const [name, value] of fields) formData.append(name, value);
  for (const file of files) {
    formData.append(
      file.fieldName,
      new File(file.chunks, file.fileName, { type: file.mimeType }),
    );
  }
  return formData;
}
