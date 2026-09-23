//! 表浏览分页计划。游标保存在进程内，客户端只持有无业务内容的随机令牌。

use crate::models::types::{TablePageNavigation, TablePagination};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(300);
const MAX_METADATA: usize = 256;
const MAX_CURSORS: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Engine {
    MySql,
    Postgres,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PageContext {
    pub engine: Engine,
    pub connection: String,
    pub database: String,
    pub table: String,
    pub filter: String,
    pub sort: Vec<(String, String)>,
    pub page_size: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IntegerKind {
    Signed,
    Unsigned,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IntegerValue {
    Signed(i64),
    Unsigned(u64),
}

impl IntegerValue {
    pub fn sql(self) -> String {
        match self {
            Self::Signed(v) => v.to_string(),
            Self::Unsigned(v) => v.to_string(),
        }
    }
    pub fn from_postgres(value: &str) -> Option<Self> {
        value.parse().ok().map(Self::Signed)
    }
    pub fn from_mysql(value: &mysql_async::Value, kind: IntegerKind) -> Option<Self> {
        // query 的文本协议将整数也表示为 Bytes；只按真实主键元数据解释为整数。
        match (value, kind) {
            (mysql_async::Value::Bytes(bytes), IntegerKind::Signed) => std::str::from_utf8(bytes)
                .ok()?
                .parse()
                .ok()
                .map(Self::Signed),
            (mysql_async::Value::Bytes(bytes), IntegerKind::Unsigned) => std::str::from_utf8(bytes)
                .ok()?
                .parse()
                .ok()
                .map(Self::Unsigned),
            (mysql_async::Value::Int(value), IntegerKind::Signed) => Some(Self::Signed(*value)),
            (mysql_async::Value::UInt(value), IntegerKind::Unsigned) => {
                Some(Self::Unsigned(*value))
            }
            (mysql_async::Value::Int(value), IntegerKind::Unsigned) => {
                u64::try_from(*value).ok().map(Self::Unsigned)
            }
            (mysql_async::Value::UInt(value), IntegerKind::Signed) => {
                i64::try_from(*value).ok().map(Self::Signed)
            }
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ColumnMetadata {
    pub name: String,
    pub primary_position: Option<i32>,
    pub integer_kind: Option<IntegerKind>,
}

#[derive(Clone, Debug)]
pub struct TableMetadata {
    pub columns: Vec<String>,
    pub primary_keys: Vec<String>,
    pub reliable_primary_keys: bool,
    pub mysql_columns: Vec<crate::db::mysql_deferred_fields::MysqlColumn>,
    trusted_primary_key: bool,
    key: Option<(String, IntegerKind)>,
    revision: String,
}

impl TableMetadata {
    pub fn with_primary_key_evidence(mut self, complete_primary_keys: &[String]) -> Self {
        self.reliable_primary_keys = self.trusted_primary_key
            && !self.primary_keys.is_empty()
            && self.primary_keys.len() == complete_primary_keys.len()
            && self
                .primary_keys
                .iter()
                .all(|key| complete_primary_keys.contains(key));
        // COLUMNS/KCU 可能因列权限只展示复合主键的一部分；必须有完整主键索引证据。
        if !matches!((self.key.as_ref(), complete_primary_keys), (Some((column, _)), [primary]) if column == primary)
        {
            self.key = None;
        }
        self
    }

    pub fn new(columns: Vec<ColumnMetadata>, trusted_primary_key: bool) -> Self {
        let mut primary: Vec<_> = columns
            .iter()
            .filter(|c| c.primary_position.is_some())
            .collect();
        primary.sort_by_key(|c| c.primary_position);
        let key = if trusted_primary_key && primary.len() == 1 {
            primary[0]
                .integer_kind
                .map(|kind| (primary[0].name.clone(), kind))
        } else {
            None
        };
        Self {
            columns: columns.iter().map(|c| c.name.clone()).collect(),
            primary_keys: primary.iter().map(|c| c.name.clone()).collect(),
            trusted_primary_key,
            reliable_primary_keys: false,
            mysql_columns: vec![],
            key,
            revision: uuid::Uuid::new_v4().to_string(),
        }
    }

    pub fn selected_columns(&self, requested: &Option<Vec<String>>) -> Option<Vec<String>> {
        let mut columns = requested.as_ref().filter(|c| !c.is_empty())?.clone();
        for primary in &self.primary_keys {
            if !columns.contains(primary) {
                columns.push(primary.clone());
            }
        }
        Some(columns)
    }
}

type TableIdentity = (Engine, String, String, String);
impl PageContext {
    fn table_identity(&self) -> TableIdentity {
        (
            self.engine,
            self.connection.clone(),
            self.database.clone(),
            self.table.clone(),
        )
    }
}

struct Timed<T> {
    value: T,
    created: Instant,
}
struct Cursor {
    context: PageContext,
    revision: String,
    page: u32,
    direction: String,
    value: IntegerValue,
}
#[derive(Default)]
struct PaginationCache {
    metadata: HashMap<TableIdentity, Timed<TableMetadata>>,
    cursors: HashMap<String, Timed<Cursor>>,
}
static CACHE: OnceLock<Mutex<PaginationCache>> = OnceLock::new();
fn cache() -> std::sync::MutexGuard<'static, PaginationCache> {
    CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

pub fn remember_metadata(context: &PageContext, metadata: TableMetadata) -> TableMetadata {
    let mut cache = cache();
    trim_cache(&mut cache.metadata, MAX_METADATA);
    cache.metadata.insert(
        context.table_identity(),
        Timed {
            value: metadata.clone(),
            created: Instant::now(),
        },
    );
    metadata
}

fn trim_cache<K: std::hash::Hash + Eq + Clone, T>(
    entries: &mut HashMap<K, Timed<T>>,
    capacity: usize,
) {
    entries.retain(|_, entry| entry.created.elapsed() < CACHE_TTL);
    if entries.len() >= capacity {
        if let Some(oldest) = entries
            .iter()
            .min_by_key(|(_, entry)| entry.created)
            .map(|(key, _)| key.clone())
        {
            entries.remove(&oldest);
        }
    }
}

fn valid_cursor<'a>(
    cache: &'a PaginationCache,
    context: &PageContext,
    page: u32,
    navigation: &TablePageNavigation,
) -> Option<(&'a Cursor, &'a TableMetadata)> {
    let cursor = cache.cursors.get(&navigation.cursor)?;
    let metadata = cache.metadata.get(&context.table_identity())?;
    if cursor.created.elapsed() >= CACHE_TTL
        || metadata.created.elapsed() >= CACHE_TTL
        || cursor.value.context != *context
        || cursor.value.page != page
        || cursor.value.direction != navigation.direction
        || cursor.value.revision != metadata.value.revision
    {
        return None;
    }
    Some((&cursor.value, &metadata.value))
}

pub fn cached_metadata_for_navigation(
    context: &PageContext,
    page: u32,
    navigation: Option<&TablePageNavigation>,
) -> Option<TableMetadata> {
    let cache = cache();
    valid_cursor(&cache, context, page, navigation?).map(|(_, metadata)| metadata.clone())
}

pub struct PagePlan {
    context: PageContext,
    metadata: TableMetadata,
    page: u32,
    pub key_column: Option<String>,
    pub sort_order: String,
    pub boundary: Option<IntegerValue>,
    pub reverse: bool,
}

impl PagePlan {
    pub fn integer_kind(&self) -> Option<IntegerKind> {
        self.metadata.key.as_ref().map(|(_, kind)| *kind)
    }

    pub fn new(
        context: PageContext,
        metadata: TableMetadata,
        page: u32,
        navigation: Option<&TablePageNavigation>,
    ) -> Self {
        let effective_sort = metadata.key.as_ref().and_then(|(key, _)| {
            if context.page_size == 0 || page == 0 {
                return None;
            }
            match context.sort.as_slice() {
                [] => Some((key.clone(), "ASC".to_string())),
                [(column, order)]
                    if column.trim() == key
                        && matches!(order.to_uppercase().as_str(), "ASC" | "DESC") =>
                {
                    Some((key.clone(), order.to_uppercase()))
                }
                _ => None,
            }
        });
        let (key_column, sort_order) = effective_sort
            .map(|(key, order)| (Some(key), order))
            .unwrap_or((None, "ASC".to_string()));
        let boundary = if key_column.is_some() {
            navigation.and_then(|nav| {
                let cache = cache();
                let (cursor, _) = valid_cursor(&cache, &context, page, nav)?;
                (cursor.revision == metadata.revision).then_some(cursor.value)
            })
        } else {
            None
        };
        let reverse =
            boundary.is_some() && navigation.is_some_and(|nav| nav.direction == "previous");
        Self {
            context,
            metadata,
            page,
            key_column,
            sort_order,
            boundary,
            reverse,
        }
    }

    pub fn sql(
        &self,
        selected: &str,
        qualified_table: &str,
        quoted_key: &str,
        fallback_order: &str,
    ) -> String {
        let mut predicates = Vec::new();
        if !self.context.filter.is_empty() {
            predicates.push(format!("({})", self.context.filter));
        }
        if let Some(boundary) = self.boundary {
            let comparison = if (self.sort_order == "ASC") != self.reverse {
                ">"
            } else {
                "<"
            };
            let value = boundary.sql();
            predicates.push(format!("{quoted_key} {comparison} {value}"));
        }
        let filter = if predicates.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", predicates.join(" AND "))
        };
        let order = if self.key_column.is_some() {
            let direction = if self.reverse {
                if self.sort_order == "ASC" {
                    "DESC"
                } else {
                    "ASC"
                }
            } else {
                &self.sort_order
            };
            format!(" ORDER BY {quoted_key} {direction}")
        } else {
            fallback_order.to_string()
        };
        let offset = if self.boundary.is_some() {
            String::new()
        } else {
            format!(" OFFSET {}", page_offset(self.page, self.context.page_size))
        };
        format!(
            "SELECT {selected} FROM {qualified_table}{filter}{order} LIMIT {}{offset}",
            self.context.page_size
        )
    }

    pub fn pagination(
        &self,
        first: Option<IntegerValue>,
        last: Option<IntegerValue>,
        row_count: usize,
    ) -> Option<TablePagination> {
        let key = self.key_column.as_ref()?;
        let mut cache = cache();
        let mut insert = |value, page, direction: &str| {
            trim_cache(&mut cache.cursors, MAX_CURSORS);
            let token = uuid::Uuid::new_v4().to_string();
            cache.cursors.insert(
                token.clone(),
                Timed {
                    value: Cursor {
                        context: self.context.clone(),
                        revision: self.metadata.revision.clone(),
                        page,
                        direction: direction.into(),
                        value,
                    },
                    created: Instant::now(),
                },
            );
            token
        };
        let next_cursor = if row_count == self.context.page_size as usize {
            last.zip(self.page.checked_add(1))
                .map(|(value, page)| insert(value, page, "next"))
        } else {
            None
        };
        let previous_cursor = if self.page > 1 {
            first.map(|value| insert(value, self.page - 1, "previous"))
        } else {
            None
        };
        Some(TablePagination {
            mode: if self.boundary.is_some() {
                "keyset"
            } else {
                "offset"
            }
            .into(),
            sort_column: key.clone(),
            sort_order: self.sort_order.clone(),
            next_cursor,
            previous_cursor,
        })
    }
}

fn page_offset(page: u32, page_size: u32) -> u64 {
    u64::from(page.saturating_sub(1)) * u64::from(page_size)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context() -> PageContext {
        PageContext {
            engine: Engine::Postgres,
            connection: uuid::Uuid::new_v4().to_string(),
            database: "main".into(),
            table: "items".into(),
            filter: String::new(),
            sort: vec![],
            page_size: 2,
        }
    }
    fn metadata() -> TableMetadata {
        TableMetadata::new(
            vec![
                ColumnMetadata {
                    name: "id".into(),
                    primary_position: Some(1),
                    integer_kind: Some(IntegerKind::Signed),
                },
                ColumnMetadata {
                    name: "value".into(),
                    primary_position: None,
                    integer_kind: None,
                },
            ],
            true,
        )
    }
    fn plan(
        context: &PageContext,
        page: u32,
        navigation: Option<&TablePageNavigation>,
    ) -> PagePlan {
        let meta = cached_metadata_for_navigation(context, page, navigation)
            .unwrap_or_else(|| remember_metadata(context, metadata()));
        PagePlan::new(context.clone(), meta, page, navigation)
    }
    fn navigation(pagination: &TablePagination, direction: &str) -> TablePageNavigation {
        TablePageNavigation {
            direction: direction.into(),
            cursor: if direction == "next" {
                pagination.next_cursor.clone().unwrap()
            } else {
                pagination.previous_cursor.clone().unwrap()
            },
        }
    }
    #[test]
    fn offset_uses_64_bit_multiplication() {
        assert_eq!(page_offset(u32::MAX, u32::MAX), 18_446_744_060_824_649_730);
    }
    #[test]
    fn only_a_real_single_integer_primary_key_and_its_single_sort_are_eligible() {
        let ctx = context();
        assert_eq!(plan(&ctx, 1, None).key_column.as_deref(), Some("id"));
        for sort in [
            vec![("value".into(), "ASC".into())],
            vec![("id".into(), "ASC".into()), ("value".into(), "DESC".into())],
            vec![("id".into(), "invalid".into())],
        ] {
            assert!(plan(
                &PageContext {
                    sort,
                    ..ctx.clone()
                },
                1,
                None
            )
            .key_column
            .is_none());
        }
        let mut meta = metadata();
        meta.key = None;
        assert!(PagePlan::new(ctx.clone(), meta, 1, None)
            .key_column
            .is_none());
        let composite = TableMetadata::new(
            vec![
                ColumnMetadata {
                    name: "id".into(),
                    primary_position: Some(1),
                    integer_kind: Some(IntegerKind::Signed),
                },
                ColumnMetadata {
                    name: "other".into(),
                    primary_position: Some(2),
                    integer_kind: Some(IntegerKind::Signed),
                },
            ],
            true,
        );
        assert!(PagePlan::new(ctx, composite, 1, None).key_column.is_none());
    }
    #[test]
    fn offset_pages_create_boundaries_and_next_previous_preserve_or_filter() {
        let ctx = PageContext {
            filter: "value = 'a' OR value = 'b'".into(),
            ..context()
        };
        let initial = plan(&ctx, 3, None);
        assert_eq!(initial.sql("*", "items", "\"id\"", ""), "SELECT * FROM items WHERE (value = 'a' OR value = 'b') ORDER BY \"id\" ASC LIMIT 2 OFFSET 4");
        let paging = initial
            .pagination(
                Some(IntegerValue::Signed(10)),
                Some(IntegerValue::Signed(20)),
                2,
            )
            .unwrap();
        assert_eq!(paging.mode, "offset");
        let next = plan(&ctx, 4, Some(&navigation(&paging, "next")));
        assert_eq!(next.sql("*", "items", "\"id\"", ""), "SELECT * FROM items WHERE (value = 'a' OR value = 'b') AND \"id\" > 20 ORDER BY \"id\" ASC LIMIT 2");
        let previous = plan(&ctx, 2, Some(&navigation(&paging, "previous")));
        assert!(previous.reverse);
        assert_eq!(previous.sql("*", "items", "\"id\"", ""), "SELECT * FROM items WHERE (value = 'a' OR value = 'b') AND \"id\" < 10 ORDER BY \"id\" DESC LIMIT 2");
    }
    #[test]
    fn cursors_bind_every_context_field_page_direction_and_metadata_revision() {
        let ctx = context();
        let initial = plan(&ctx, 2, None);
        let paging = initial
            .pagination(
                Some(IntegerValue::Signed(3)),
                Some(IntegerValue::Signed(4)),
                2,
            )
            .unwrap();
        let next = navigation(&paging, "next");
        assert!(cached_metadata_for_navigation(&ctx, 3, Some(&next)).is_some());
        for changed in [
            PageContext {
                connection: "other".into(),
                ..ctx.clone()
            },
            PageContext {
                database: "other".into(),
                ..ctx.clone()
            },
            PageContext {
                table: "other".into(),
                ..ctx.clone()
            },
            PageContext {
                filter: "id > 0".into(),
                ..ctx.clone()
            },
            PageContext {
                sort: vec![("id".into(), "DESC".into())],
                ..ctx.clone()
            },
            PageContext {
                page_size: 3,
                ..ctx.clone()
            },
            PageContext {
                engine: Engine::MySql,
                ..ctx.clone()
            },
        ] {
            assert!(cached_metadata_for_navigation(&changed, 3, Some(&next)).is_none());
        }
        assert!(cached_metadata_for_navigation(&ctx, 4, Some(&next)).is_none());
        assert!(cached_metadata_for_navigation(
            &ctx,
            3,
            Some(&TablePageNavigation {
                direction: "previous".into(),
                cursor: next.cursor.clone()
            })
        )
        .is_none());
        remember_metadata(&ctx, metadata());
        assert!(cached_metadata_for_navigation(&ctx, 3, Some(&next)).is_none());
    }
    #[test]
    fn integer_boundaries_remain_lossless_and_cannot_contain_sql() {
        for text in [
            "-9223372036854775808",
            "9223372036854775807",
            "9007199254740993",
        ] {
            assert_eq!(IntegerValue::from_postgres(text).unwrap().sql(), text);
        }
        for text in ["9223372036854775808", "1 OR 1=1", "1.0", "NaN"] {
            assert!(IntegerValue::from_postgres(text).is_none());
        }
        assert_eq!(
            IntegerValue::from_mysql(&mysql_async::Value::UInt(u64::MAX), IntegerKind::Unsigned)
                .unwrap()
                .sql(),
            "18446744073709551615"
        );
        let ctx = context();
        let paging = plan(&ctx, 1, None)
            .pagination(
                Some(IntegerValue::Signed(i64::MIN)),
                Some(IntegerValue::Signed(i64::MAX)),
                2,
            )
            .unwrap();
        let next = plan(&ctx, 2, Some(&navigation(&paging, "next")));
        assert_eq!(next.boundary, Some(IntegerValue::Signed(i64::MAX)));
        assert!(!paging.next_cursor.unwrap().contains("922337"));
    }
    #[test]
    fn generated_sql_traverses_actual_rows_in_both_directions_after_offset_jump() {
        fn verify(descending: bool) {
            let db = rusqlite::Connection::open_in_memory().unwrap();
            db.execute_batch("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (-9, 'a'), (-3, 'b'), (1, 'x'), (4, 'a'), (7, 'b'), (9007199254740993, 'a'), (9223372036854775807, 'b');").unwrap();
            let ctx = PageContext {
                filter: "value = 'a' OR value = 'b'".into(),
                sort: if descending {
                    vec![("id".into(), "DESC".into())]
                } else {
                    vec![]
                },
                ..context()
            };
            let run = |plan: &PagePlan| {
                let mut statement = db.prepare(&plan.sql("id", "items", "\"id\"", "")).unwrap();
                let mut rows: Vec<i64> = statement
                    .query_map([], |r| r.get(0))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                if plan.reverse {
                    rows.reverse();
                }
                let paging = plan
                    .pagination(
                        rows.first().copied().map(IntegerValue::Signed),
                        rows.last().copied().map(IntegerValue::Signed),
                        rows.len(),
                    )
                    .unwrap();
                (rows, paging)
            };
            let (first, first_paging) = run(&plan(&ctx, 1, None));
            let (second, second_paging) =
                run(&plan(&ctx, 2, Some(&navigation(&first_paging, "next"))));
            let (back, _) = run(&plan(
                &ctx,
                1,
                Some(&navigation(&second_paging, "previous")),
            ));
            assert_eq!(back, first);
            assert_eq!(second, if descending { vec![7, 4] } else { vec![4, 7] });
            let (jumped, jumped_paging) = run(&plan(&ctx, 2, None));
            assert_eq!(jumped, second);
            let (third, _) = run(&plan(&ctx, 3, Some(&navigation(&jumped_paging, "next"))));
            assert_eq!(
                third,
                if descending {
                    vec![-3, -9]
                } else {
                    vec![9007199254740993, i64::MAX]
                }
            );
        }
        verify(false);
        verify(true);
    }
    #[test]
    fn selected_columns_keep_primary_keys_available_for_editing() {
        assert_eq!(
            metadata().selected_columns(&Some(vec!["value".into()])),
            Some(vec!["value".into(), "id".into()])
        );
        assert!(metadata().selected_columns(&Some(vec![])).is_none());
    }

    #[test]
    fn expired_metadata_or_cursor_and_unknown_tokens_fall_back_to_the_requested_offset() {
        let ctx = context();
        let initial = plan(&ctx, 1, None);
        let paging = initial
            .pagination(
                Some(IntegerValue::Signed(1)),
                Some(IntegerValue::Signed(2)),
                2,
            )
            .unwrap();
        let next = navigation(&paging, "next");
        cache().cursors.get_mut(&next.cursor).unwrap().created = Instant::now() - CACHE_TTL;
        assert!(cached_metadata_for_navigation(&ctx, 2, Some(&next)).is_none());
        let fallback = plan(&ctx, 4, Some(&next));
        assert!(fallback.boundary.is_none());
        assert!(fallback
            .sql("*", "items", "id", "")
            .ends_with("LIMIT 2 OFFSET 6"));

        let paging = fallback
            .pagination(
                Some(IntegerValue::Signed(7)),
                Some(IntegerValue::Signed(8)),
                2,
            )
            .unwrap();
        let next = navigation(&paging, "next");
        cache()
            .metadata
            .get_mut(&ctx.table_identity())
            .unwrap()
            .created = Instant::now() - CACHE_TTL;
        assert!(cached_metadata_for_navigation(&ctx, 5, Some(&next)).is_none());
        let invalid = TablePageNavigation {
            direction: "next".into(),
            cursor: "0 OR 1=1".into(),
        };
        assert!(plan(&ctx, 2, Some(&invalid)).boundary.is_none());
    }

    #[test]
    fn cache_removes_expired_entries_and_evicts_oldest_before_insertion() {
        let now = Instant::now();
        let mut entries = HashMap::from([
            (
                "expired",
                Timed {
                    value: 1,
                    created: now - CACHE_TTL,
                },
            ),
            (
                "oldest",
                Timed {
                    value: 2,
                    created: now - Duration::from_secs(2),
                },
            ),
            (
                "newest",
                Timed {
                    value: 3,
                    created: now,
                },
            ),
        ]);
        trim_cache(&mut entries, 2);
        entries.insert(
            "incoming",
            Timed {
                value: 4,
                created: now,
            },
        );
        assert_eq!(entries.len(), 2);
        assert!(entries.contains_key("newest"));
        assert!(entries.contains_key("incoming"));
    }

    #[test]
    fn empty_partial_and_last_numbered_pages_do_not_offer_an_invalid_next_cursor() {
        let ctx = context();
        let partial = plan(&ctx, 2, None)
            .pagination(
                Some(IntegerValue::Signed(3)),
                Some(IntegerValue::Signed(3)),
                1,
            )
            .unwrap();
        assert!(partial.next_cursor.is_none());
        assert!(partial.previous_cursor.is_some());
        let empty = plan(&ctx, 2, None).pagination(None, None, 0).unwrap();
        assert!(empty.next_cursor.is_none());
        assert!(empty.previous_cursor.is_none());
        // MySQL SELECT * 不包含数据库级 INVISIBLE 主键：没有原始边界就不能导航。
        let missing_key = plan(&ctx, 2, None).pagination(None, None, 2).unwrap();
        assert!(missing_key.next_cursor.is_none());
        assert!(missing_key.previous_cursor.is_none());
        let last = plan(&ctx, u32::MAX, None)
            .pagination(
                Some(IntegerValue::Signed(1)),
                Some(IntegerValue::Signed(2)),
                2,
            )
            .unwrap();
        assert!(last.next_cursor.is_none());
    }

    #[test]
    fn unsupported_primary_keys_keep_the_original_sort_and_offset_behavior() {
        let ctx = context();
        for (trusted, primary_position, integer_kind) in [
            (false, Some(1), Some(IntegerKind::Signed)),
            (true, None, Some(IntegerKind::Signed)),
            (true, Some(1), None),
        ] {
            let metadata = TableMetadata::new(
                vec![ColumnMetadata {
                    name: "id".into(),
                    primary_position,
                    integer_kind,
                }],
                trusted,
            );
            let plan = PagePlan::new(ctx.clone(), metadata, 3, None);
            assert_eq!(
                plan.sql("*", "items", "id", " ORDER BY value DESC"),
                "SELECT * FROM items ORDER BY value DESC LIMIT 2 OFFSET 4"
            );
            assert!(plan.pagination(None, None, 0).is_none());
        }
    }

    #[test]
    fn table_response_is_flat_without_changing_the_full_row_result_shape() {
        use crate::models::types::{QueryResult, TablePageResult};
        let original = QueryResult {
            columns: vec!["id".into()],
            rows: vec![vec![serde_json::json!(1)]],
            total: 1,
            execution_time_ms: 0,
        };
        let legacy = serde_json::to_value(&original).unwrap();
        assert_eq!(legacy.as_object().unwrap().len(), 4);
        let table = serde_json::to_value(TablePageResult::from(original)).unwrap();
        assert!(table.get("result").is_none());
        assert_eq!(table["rows"], serde_json::json!([[1]]));
        assert!(table["pagination"].is_null());
    }

    #[test]
    fn mysql_text_protocol_integer_boundaries_are_parsed_without_losing_precision() {
        for (text, kind, expected) in [
            (
                "9007199254740993",
                IntegerKind::Signed,
                IntegerValue::Signed(9007199254740993),
            ),
            (
                "-9223372036854775808",
                IntegerKind::Signed,
                IntegerValue::Signed(i64::MIN),
            ),
            (
                "18446744073709551615",
                IntegerKind::Unsigned,
                IntegerValue::Unsigned(u64::MAX),
            ),
        ] {
            assert_eq!(
                IntegerValue::from_mysql(
                    &mysql_async::Value::Bytes(text.as_bytes().to_vec()),
                    kind
                ),
                Some(expected)
            );
        }
        for (text, kind) in [
            ("18446744073709551615", IntegerKind::Signed),
            ("-1", IntegerKind::Unsigned),
            ("1 OR 1=1", IntegerKind::Signed),
            ("1.0", IntegerKind::Signed),
        ] {
            assert_eq!(
                IntegerValue::from_mysql(
                    &mysql_async::Value::Bytes(text.as_bytes().to_vec()),
                    kind
                ),
                None
            );
        }
    }

    #[test]
    fn partially_visible_composite_primary_key_cannot_be_used_as_a_unique_boundary() {
        let partial = metadata().with_primary_key_evidence(&["id".into(), "tenant_id".into()]);
        assert!(PagePlan::new(context(), partial, 1, None)
            .key_column
            .is_none());
        let mismatched = metadata().with_primary_key_evidence(&["other".into()]);
        assert!(PagePlan::new(context(), mismatched, 1, None)
            .key_column
            .is_none());
        let complete = metadata().with_primary_key_evidence(&["id".into()]);
        assert_eq!(
            PagePlan::new(context(), complete, 1, None)
                .key_column
                .as_deref(),
            Some("id")
        );
    }
    #[test]
    fn complete_composite_primary_evidence_is_required_for_deferred_reload() {
        let make = || {
            TableMetadata::new(
                vec![
                    ColumnMetadata {
                        name: "tenant".into(),
                        primary_position: Some(1),
                        integer_kind: None,
                    },
                    ColumnMetadata {
                        name: "id".into(),
                        primary_position: Some(2),
                        integer_kind: Some(IntegerKind::Unsigned),
                    },
                ],
                true,
            )
        };
        assert!(
            make()
                .with_primary_key_evidence(&["id".into(), "tenant".into()])
                .reliable_primary_keys
        );
        assert!(
            !make()
                .with_primary_key_evidence(&["id".into()])
                .reliable_primary_keys
        );
        assert!(!make().with_primary_key_evidence(&[]).reliable_primary_keys);
        let view = TableMetadata::new(
            vec![ColumnMetadata {
                name: "id".into(),
                primary_position: Some(1),
                integer_kind: Some(IntegerKind::Signed),
            }],
            false,
        );
        assert!(
            !view
                .with_primary_key_evidence(&["id".into()])
                .reliable_primary_keys
        );
    }
}
