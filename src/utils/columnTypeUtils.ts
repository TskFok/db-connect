/** MySQL 数据类型分组选项 (用于 Select 下拉框) */
export const MYSQL_DATA_TYPES = [
  {
    label: "数值类型",
    options: [
      { label: "tinyint", value: "tinyint" },
      { label: "smallint", value: "smallint" },
      { label: "mediumint", value: "mediumint" },
      { label: "int", value: "int" },
      { label: "bigint", value: "bigint" },
      { label: "decimal", value: "decimal" },
      { label: "float", value: "float" },
      { label: "double", value: "double" },
      { label: "bit", value: "bit" },
    ],
  },
  {
    label: "字符串类型",
    options: [
      { label: "char", value: "char" },
      { label: "varchar", value: "varchar" },
      { label: "tinytext", value: "tinytext" },
      { label: "text", value: "text" },
      { label: "mediumtext", value: "mediumtext" },
      { label: "longtext", value: "longtext" },
      { label: "enum", value: "enum" },
      { label: "set", value: "set" },
    ],
  },
  {
    label: "二进制类型",
    options: [
      { label: "binary", value: "binary" },
      { label: "varbinary", value: "varbinary" },
      { label: "tinyblob", value: "tinyblob" },
      { label: "blob", value: "blob" },
      { label: "mediumblob", value: "mediumblob" },
      { label: "longblob", value: "longblob" },
    ],
  },
  {
    label: "日期时间类型",
    options: [
      { label: "date", value: "date" },
      { label: "datetime", value: "datetime" },
      { label: "timestamp", value: "timestamp" },
      { label: "time", value: "time" },
      { label: "year", value: "year" },
    ],
  },
  {
    label: "其他类型",
    options: [{ label: "json", value: "json" }],
  },
];

/** 支持 UNSIGNED 修饰符的数据类型 */
export const UNSIGNED_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "bigint",
  "decimal",
  "float",
  "double",
]);

/** 支持长度/精度的数据类型 */
export const LENGTH_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "bigint",
  "decimal",
  "float",
  "double",
  "bit",
  "char",
  "varchar",
  "binary",
  "varbinary",
  "enum",
  "set",
  "datetime",
  "timestamp",
  "time",
]);

/** 使用 (M,D) 精度/小数位格式的数据类型 */
export const SCALE_TYPES = new Set(["decimal", "float", "double"]);

/** PostgreSQL 常用数据类型分组（用于 Select 下拉框）。
 *  名称沿用 PostgreSQL 官方简称；用户可在「类型」字段中自由输入更细粒度的类型。 */
export const POSTGRES_DATA_TYPES = [
  {
    label: "数值类型",
    options: [
      { label: "smallint", value: "smallint" },
      { label: "integer", value: "integer" },
      { label: "bigint", value: "bigint" },
      { label: "numeric", value: "numeric" },
      { label: "real", value: "real" },
      { label: "double precision", value: "double precision" },
      { label: "serial", value: "serial" },
      { label: "bigserial", value: "bigserial" },
    ],
  },
  {
    label: "字符串类型",
    options: [
      { label: "varchar", value: "varchar" },
      { label: "text", value: "text" },
      { label: "char", value: "char" },
    ],
  },
  {
    label: "日期时间类型",
    options: [
      { label: "date", value: "date" },
      { label: "time", value: "time" },
      { label: "timestamp", value: "timestamp" },
      { label: "timestamptz", value: "timestamptz" },
      { label: "interval", value: "interval" },
    ],
  },
  {
    label: "其他类型",
    options: [
      { label: "boolean", value: "boolean" },
      { label: "uuid", value: "uuid" },
      { label: "json", value: "json" },
      { label: "jsonb", value: "jsonb" },
      { label: "bytea", value: "bytea" },
    ],
  },
];

/** PostgreSQL 中支持 (length) 的类型 */
export const POSTGRES_LENGTH_TYPES = new Set([
  "varchar",
  "char",
  "bit",
  "varbit",
]);

/** PostgreSQL 中支持 (M,D) 的类型 */
export const POSTGRES_SCALE_TYPES = new Set(["numeric", "decimal"]);

/** SQLite 常用类型亲和性（用于 Select 下拉框）。 */
export const SQLITE_DATA_TYPES = [
  {
    label: "SQLite 类型",
    options: [
      { label: "INTEGER", value: "INTEGER" },
      { label: "REAL", value: "REAL" },
      { label: "TEXT", value: "TEXT" },
      { label: "BLOB", value: "BLOB" },
      { label: "NUMERIC", value: "NUMERIC" },
    ],
  },
];

export const SQLITE_LENGTH_TYPES = new Set<string>();
export const SQLITE_SCALE_TYPES = new Set<string>();

/** SQL Server 常用数据类型分组（用于 Select 下拉框）。 */
export const SQLSERVER_DATA_TYPES = [
  {
    label: "数值类型",
    options: [
      { label: "int", value: "int" },
      { label: "bigint", value: "bigint" },
      { label: "bit", value: "bit" },
      { label: "decimal(18,2)", value: "decimal" },
    ],
  },
  {
    label: "字符串类型",
    options: [
      { label: "nvarchar(255)", value: "nvarchar" },
      { label: "varchar(255)", value: "varchar" },
    ],
  },
  {
    label: "日期时间类型",
    options: [
      { label: "datetime2", value: "datetime2" },
      { label: "datetimeoffset", value: "datetimeoffset" },
    ],
  },
  {
    label: "其他类型",
    options: [
      { label: "uniqueidentifier", value: "uniqueidentifier" },
      { label: "varbinary(max)", value: "varbinary" },
    ],
  },
];

export const SQLSERVER_LENGTH_TYPES = new Set([
  "char",
  "varchar",
  "nchar",
  "nvarchar",
  "binary",
  "varbinary",
  "decimal",
  "numeric",
]);
export const SQLSERVER_SCALE_TYPES = new Set(["decimal", "numeric"]);
export const SQLSERVER_UNSIGNED_TYPES = new Set<string>();

/** 解析后的列类型结构 */
export interface ParsedColumnType {
  /** 基础数据类型 (如 varchar, int) */
  dataType: string;
  /** 长度/精度 (如 255 或 10) */
  length: string;
  /** 小数位数 (仅 decimal/float/double, 如 2) */
  scale: string;
  /** 是否为 unsigned */
  unsigned: boolean;
}

/**
 * 将完整的列类型字符串解析为结构化对象
 * 例如: "varchar(255)" -> { dataType: "varchar", length: "255", scale: "", unsigned: false }
 *       "bigint(20) unsigned" -> { dataType: "bigint", length: "20", scale: "", unsigned: true }
 *       "decimal(10,2) unsigned" -> { dataType: "decimal", length: "10", scale: "2", unsigned: true }
 */
export function parseColumnType(columnType: string): ParsedColumnType {
  const trimmed = columnType.trim().toLowerCase();

  // 检查 unsigned
  const unsigned = trimmed.endsWith(" unsigned");
  const withoutUnsigned = unsigned
    ? trimmed.slice(0, -" unsigned".length).trim()
    : trimmed;

  // 提取基础类型和长度
  const parenStart = withoutUnsigned.indexOf("(");
  if (parenStart === -1) {
    return {
      dataType: withoutUnsigned,
      length: "",
      scale: "",
      unsigned,
    };
  }

  const dataType = withoutUnsigned.slice(0, parenStart).trim();
  const parenEnd = withoutUnsigned.lastIndexOf(")");
  const rawContent =
    parenEnd > parenStart
      ? withoutUnsigned.slice(parenStart + 1, parenEnd).trim()
      : "";

  // 对 decimal/float/double 拆分精度和小数位数
  if (SCALE_TYPES.has(dataType) && rawContent.includes(",")) {
    const parts = rawContent.split(",");
    return {
      dataType,
      length: parts[0].trim(),
      scale: parts[1].trim(),
      unsigned,
    };
  }

  return { dataType, length: rawContent, scale: "", unsigned };
}

/**
 * 将结构化的列类型信息组合为完整的列类型字符串
 * 例如: buildColumnType("varchar", "255", "", false) -> "varchar(255)"
 *       buildColumnType("decimal", "10", "2", true) -> "decimal(10,2) unsigned"
 */
export function buildColumnType(
  dataType: string,
  length: string,
  scale: string,
  unsigned: boolean
): string {
  return buildColumnTypeWithConfig(dataType, length, scale, unsigned, {
    scaleTypes: SCALE_TYPES,
    unsignedTypes: UNSIGNED_TYPES,
  });
}

export function buildColumnTypeWithConfig(
  dataType: string,
  length: string,
  scale: string,
  unsigned: boolean,
  config: {
    scaleTypes?: ReadonlySet<string>;
    unsignedTypes?: ReadonlySet<string>;
  } = {}
): string {
  let result = dataType;
  const scaleTypes = config.scaleTypes ?? SCALE_TYPES;
  const unsignedTypes = config.unsignedTypes ?? UNSIGNED_TYPES;

  const trimLength = length.trim();
  const trimScale = scale.trim();

  if (trimLength) {
    if (trimScale && scaleTypes.has(dataType.toLowerCase())) {
      result += `(${trimLength},${trimScale})`;
    } else {
      result += `(${trimLength})`;
    }
  }

  if (unsigned && unsignedTypes.has(dataType.toLowerCase())) {
    result += " unsigned";
  }

  return result;
}
