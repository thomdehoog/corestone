package foundation

import "github.com/thomdehoog/corestone/internal/ojson"

type ojsonObject = ojson.Object

func parseObject(s string) (*ojson.Object, error) { return ojson.ParseObject([]byte(s)) }

func must(o *ojson.Object, err error) *ojson.Object {
	if err != nil {
		panic(err)
	}
	return o
}
