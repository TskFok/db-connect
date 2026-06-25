use crate::models::types::DatabaseType;
use deadpool_postgres::Pool as PgPool;
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
