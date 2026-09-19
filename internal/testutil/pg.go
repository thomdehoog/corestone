// Package testutil holds helpers shared by integration tests.
package testutil

import (
	"database/sql"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/lib/pq" // driver
)

var seq atomic.Int64

// DSN returns a connection string to a throwaway PostgreSQL schema, or
// skips the test when CORESTONE_TEST_DSN is not set.
func DSN(t testing.TB) string {
	t.Helper()
	dsn := os.Getenv("CORESTONE_TEST_DSN")
	if dsn == "" {
		t.Skip("CORESTONE_TEST_DSN not set; skipping PostgreSQL-backed test")
	}
	name := fmt.Sprintf("t_%d_%d_%d", time.Now().UnixNano(), os.Getpid(), seq.Add(1))
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(`CREATE SCHEMA ` + name); err != nil {
		t.Fatalf("create test schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(`DROP SCHEMA ` + name + ` CASCADE`); err != nil {
			t.Logf("drop test schema %s: %v", name, err)
		}
		admin.Close()
	})
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	return dsn + sep + "search_path=" + name + ",public"
}
