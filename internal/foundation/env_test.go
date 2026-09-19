package foundation

import "os"

func envDSN() string { return os.Getenv("CORESTONE_TEST_DSN") }
