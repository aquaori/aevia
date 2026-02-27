require("dotenv").config();

module.exports = {
  PORT: process.env.PORT || 4646,
  HOST: process.env.HOST || "0.0.0.0",
  JWT_SECRET: process.env.JWT_SECRET || "JWT_4cac0f79-4ba3-4ae6-a498-84e54ecde8aa",
  DEFAULT_ROOM_ID: "123123",
};
