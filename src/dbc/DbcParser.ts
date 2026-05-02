import type {
  AttributeValue,
  DbcFile,
  RawDbc,
  RawDbcAttribute,
  RawDbcAttributeDefinition,
  RawDbcMessage,
  RawDbcSignal,
  RawDbcValueTable,
} from "./types.js";

const MESSAGE_RE = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/;
const SIGNAL_RE = /^SG_\s+(\w+)(?:\s+(?:M|m\d+M?))?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s+\(([-+.\deE]+),([-+.\deE]+)\)\s+\[([-+.\deE]+)\|([-+.\deE]+)\]\s+"([^"]*)"\s*(.*)$/;
const VALUE_TABLE_RE = /^VAL_\s+(\d+)\s+(\w+)\s+(.+);$/;
const ATTRIBUTE_DEFINITION_RE = /^BA_DEF_\s+(?:(SG_|BO_|BU_|EV_)\s+)?"([^"]+)"\s+(\w+)(?:\s+(.+))?;$/;
const ATTRIBUTE_RE = /^BA_\s+"([^"]+)"\s+(?:(SG_|BO_|BU_|EV_)\s+)?(.+);$/;

export class DbcParser {
  parse(file: DbcFile): RawDbc {
    const messages: RawDbcMessage[] = [];
    const attributeDefinitions: RawDbcAttributeDefinition[] = [];
    const attributes: RawDbcAttribute[] = [];
    const valueTables: RawDbcValueTable[] = [];
    let currentMessage: RawDbcMessage | undefined;

    for (const rawLine of file.content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("CM_") || line.startsWith("BU_")) {
        continue;
      }

      const messageMatch = MESSAGE_RE.exec(line);
      if (messageMatch !== null) {
        currentMessage = {
          id: Number(messageMatch[1]),
          name: messageMatch[2] ?? "",
          size: Number(messageMatch[3]),
          transmitter: messageMatch[4] ?? "",
          signals: [],
        };
        messages.push(currentMessage);
        continue;
      }

      const signalMatch = SIGNAL_RE.exec(line);
      if (signalMatch !== null) {
        if (currentMessage === undefined) {
          throw new Error(`DBC signal without preceding message in ${file.name}: ${line}`);
        }

        currentMessage.signals.push(parseSignal(signalMatch, currentMessage.id));
        continue;
      }

      const valueTableMatch = VALUE_TABLE_RE.exec(line);
      if (valueTableMatch !== null) {
        valueTables.push(parseValueTable(valueTableMatch));
        continue;
      }

      const definitionMatch = ATTRIBUTE_DEFINITION_RE.exec(line);
      if (definitionMatch !== null) {
        attributeDefinitions.push(parseAttributeDefinition(definitionMatch));
        continue;
      }

      const attributeMatch = ATTRIBUTE_RE.exec(line);
      if (attributeMatch !== null) {
        attributes.push(parseAttribute(attributeMatch));
      }
    }

    return {
      fileName: file.name,
      messages,
      attributeDefinitions,
      attributes,
      valueTables,
    };
  }
}

export function parseDbc(file: DbcFile): RawDbc {
  return new DbcParser().parse(file);
}

function parseSignal(match: RegExpExecArray, messageId: number): RawDbcSignal {
  return {
    name: match[1] ?? "",
    messageId,
    startBit: Number(match[2]),
    length: Number(match[3]),
    byteOrder: match[4] === "1" ? "little" : "big",
    signed: match[5] === "-",
    scale: Number(match[6]),
    offset: Number(match[7]),
    minimum: Number(match[8]),
    maximum: Number(match[9]),
    unit: match[10] ?? "",
    receivers: (match[11] ?? "")
      .split(",")
      .map((receiver) => receiver.trim())
      .filter(Boolean),
  };
}

function parseValueTable(match: RegExpExecArray): RawDbcValueTable {
  const values: Record<number, string> = {};
  const body = match[3] ?? "";
  const pairRe = /(-?\d+)\s+"([^"]*)"/g;
  let pair: RegExpExecArray | null = pairRe.exec(body);

  while (pair !== null) {
    values[Number(pair[1])] = pair[2] ?? "";
    pair = pairRe.exec(body);
  }

  return {
    messageId: Number(match[1]),
    signalName: match[2] ?? "",
    values,
  };
}

function parseAttributeDefinition(match: RegExpExecArray): RawDbcAttributeDefinition {
  const type = normalizeAttributeType(match[3] ?? "STRING");
  const definition: RawDbcAttributeDefinition = {
    name: match[2] ?? "",
    type,
  };
  const scope = match[1] as RawDbcAttributeDefinition["scope"] | undefined;

  if (scope !== undefined) {
    definition.scope = scope;
  }

  if (type === "ENUM") {
    definition.enumValues = parseEnumValues(match[4] ?? "");
  }

  return definition;
}

function parseAttribute(match: RegExpExecArray): RawDbcAttribute {
  const name = match[1] ?? "";
  const scope = match[2] as RawDbcAttribute["scope"] | undefined;
  const rest = (match[3] ?? "").trim();

  if (scope === "SG_") {
    const sgMatch = /^(\d+)\s+(\w+)\s+(.+)$/.exec(rest);
    if (sgMatch === null) {
      throw new Error(`Invalid signal attribute: ${name} ${rest}`);
    }

    return {
      name,
      scope,
      messageId: Number(sgMatch[1]),
      signalName: sgMatch[2] ?? "",
      value: parseAttributeValue(sgMatch[3] ?? ""),
    };
  }

  if (scope === "BO_") {
    const boMatch = /^(\d+)\s+(.+)$/.exec(rest);
    if (boMatch === null) {
      throw new Error(`Invalid message attribute: ${name} ${rest}`);
    }

    return {
      name,
      scope,
      messageId: Number(boMatch[1]),
      value: parseAttributeValue(boMatch[2] ?? ""),
    };
  }

  return {
    name,
    ...(scope !== undefined ? { scope } : {}),
    value: parseAttributeValue(rest),
  };
}

function parseAttributeValue(raw: string): AttributeValue {
  const value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1);
  }

  if (/^0x[\da-f]+$/i.test(value)) {
    return Number.parseInt(value, 16);
  }

  if (/^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(value)) {
    return Number(value);
  }

  if (value === "true" || value === "false") {
    return value === "true";
  }

  return value;
}

function normalizeAttributeType(type: string): RawDbcAttributeDefinition["type"] {
  switch (type) {
    case "STRING":
    case "INT":
    case "FLOAT":
    case "ENUM":
    case "HEX":
      return type;
    default: {
      return "STRING";
    }
  }
}

function parseEnumValues(raw: string): string[] {
  const values: string[] = [];
  const valueRe = /"([^"]*)"/g;
  let match = valueRe.exec(raw);

  while (match !== null) {
    values.push(match[1] ?? "");
    match = valueRe.exec(raw);
  }

  return values;
}
