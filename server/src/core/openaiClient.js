const OpenAI = require("openai");
const { config } = require("../config");

//  DAEMONS: point the client at any OpenAI-compatible endpoint.
//  The harness reads game state out of RAM rather than from screenshots, so
//  nothing here needs vision and the decision is text-in / button-out -- which
//  a local model can do. Unset, this falls back to api.openai.com exactly as
//  before, so the change is inert for anyone not using it.
const openai = new OpenAI({
  apiKey: config.openai.apiKey || "local",
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  timeout: config.openai.timeout,
});

module.exports = { openai };

