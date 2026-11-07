module.exports = {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"type-enum": [2, "always", ["feat", "fix", "docs", "test", "refactor", "perf", "build", "ci", "chore", "revert"]],
		"header-max-length": [2, "always", 100],
		"subject-case": [0],
	},
};
