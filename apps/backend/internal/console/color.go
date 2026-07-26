package console

func cyan(value string) string   { return "\x1b[36m" + value + "\x1b[0m" }
func green(value string) string  { return "\x1b[32m" + value + "\x1b[0m" }
func yellow(value string) string { return "\x1b[33m" + value + "\x1b[0m" }
func red(value string) string    { return "\x1b[31m" + value + "\x1b[0m" }
func dim(value string) string    { return "\x1b[2m" + value + "\x1b[0m" }
