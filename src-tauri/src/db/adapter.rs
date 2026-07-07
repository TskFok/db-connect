use crate::db::clickhouse::ClickHousePoolHandle;
use crate::db::sqlserver::SqlServerPool;
use crate::models::types::DatabaseType;
use deadpool_postgres::Pool as PgPool;
use deadpool_sqlite::Pool as SqlitePool;
use mysql_async::Pool;

pub trait DatabaseAdapter {
    fn database_type(&self) -> DatabaseType;
}

pub struct MySqlDatabaseAdapter {
    pool: Pool,
}

pub struct PostgresDatabaseAdapter {
    pool: PgPool,
}

pub struct SqliteDatabaseAdapter {
    pool: SqlitePool,
}

pub struct SqlServerDatabaseAdapter {
    pool: SqlServerPool,
}

pub struct ClickHouseDatabaseAdapter {
    handle: ClickHousePoolHandle,
}

impl MySqlDatabaseAdapter {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }

    pub fn pool_clone(&self) -> Pool {
        self.pool.clone()
    }

    pub fn into_pool(self) -> Pool {
        self.pool
    }
}

impl DatabaseAdapter for MySqlDatabaseAdapter {
    fn database_type(&self) -> DatabaseType {
        DatabaseType::MySql
    }
}

impl PostgresDatabaseAdapter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool_clone(&self) -> PgPool {
        self.pool.clone()
    }

    pub fn close(&self) {
        self.pool.close();
    }
}

impl DatabaseAdapter for PostgresDatabaseAdapter {
    fn database_type(&self) -> DatabaseType {
        DatabaseType::Postgres
    }
}

impl SqliteDatabaseAdapter {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub fn pool_clone(&self) -> SqlitePool {
        self.pool.clone()
    }

    pub fn close(&self) {
        self.pool.close();
    }
}

impl DatabaseAdapter for SqliteDatabaseAdapter {
    fn database_type(&self) -> DatabaseType {
        DatabaseType::Sqlite
    }
}

impl SqlServerDatabaseAdapter {
    pub fn new(pool: SqlServerPool) -> Self {
        Self { pool }
    }

    pub fn pool_clone(&self) -> SqlServerPool {
        self.pool.clone()
    }

    pub fn close(&self) {
        let _ = &self.pool;
    }
}

impl DatabaseAdapter for SqlServerDatabaseAdapter {
    fn database_type(&self) -> DatabaseType {
        DatabaseType::SqlServer
    }
}

impl ClickHouseDatabaseAdapter {
    pub fn new(handle: ClickHousePoolHandle) -> Self {
        Self { handle }
    }

    pub fn pool_clone(&self) -> ClickHousePoolHandle {
        self.handle.clone()
    }

    pub fn close(&self) {
        let _ = &self.handle;
    }
}

impl DatabaseAdapter for ClickHouseDatabaseAdapter {
    fn database_type(&self) -> DatabaseType {
        DatabaseType::ClickHouse
    }
}
