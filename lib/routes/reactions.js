const express = require('express');
const { normalizeReactionEmoji } = require('../reaction-events');

// Bounds for client-controlled reaction inputs. The reactions table stores
// these strings verbatim and re-serves them to every user of the session, so
// oversized values would pollute the store and bloat every reaction response.
const MAX_REACTION_EMOJI_LENGTH = 32;
const MAX_REACTION_SESSION_KEY_LENGTH = 200;
const MAX_REACTION_MESSAGE_ID_LENGTH = 200;

/**
 * Reaction API route handlers.
 *
 * @param {object} deps
 * @param {Function} deps.isAuthenticated - Auth middleware
 * @param {Function} deps.requireSessionAccess - Session access middleware factory
 * @param {string} deps.authMode - Current auth mode ('local'|'oidc'|'none')
 * @param {object} deps.reactions - In-memory reactions store (from lib/db)
 * @returns {import('express').Router}
 */
function createReactionsRoutes({ isAuthenticated, requireSessionAccess, authMode, reactions }) {
  const router = express.Router();

  // GET /api/reactions/:sessionKey - Get all reactions for a session (batch load)
  router.get('/reactions/:sessionKey', isAuthenticated, requireSessionAccess(authMode), (req, res) => {
    try {
      const { sessionKey } = req.params;
      const allReactions = reactions.getForSession(sessionKey);
      res.json({ sessionKey, reactions: allReactions });
    } catch (error) {
      console.error('Error getting reactions:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/messages/:messageId/reactions - Get reactions for a specific message
  router.get('/messages/:messageId/reactions', isAuthenticated, requireSessionAccess(authMode), (req, res) => {
    try {
      const { messageId } = req.params;
      const sessionKey = typeof req.query?.sessionKey === 'string' ? req.query.sessionKey : null;
      const messageReactions = reactions.getForMessage(messageId, sessionKey);
      res.json({ messageId, ...(sessionKey ? { sessionKey } : {}), reactions: messageReactions });
    } catch (error) {
      console.error('Error getting message reactions:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/messages/:messageId/reactions - Add or remove a reaction (toggle)
  router.post('/messages/:messageId/reactions', isAuthenticated, requireSessionAccess(authMode), (req, res) => {
    try {
      const { messageId } = req.params;
      const { emoji: rawEmoji, sessionKey } = req.body;
      const username = req.user?.username || req.user?.email || 'anonymous';

      if (!messageId || typeof messageId !== 'string' || messageId.length > MAX_REACTION_MESSAGE_ID_LENGTH) {
        return res.status(400).json({ error: `Message ID must be a string of at most ${MAX_REACTION_MESSAGE_ID_LENGTH} characters` });
      }
      if (!rawEmoji) {
        return res.status(400).json({ error: 'Emoji is required' });
      }
      if (typeof rawEmoji !== 'string' || rawEmoji.length > MAX_REACTION_EMOJI_LENGTH) {
        return res.status(400).json({ error: `Emoji must be a string of at most ${MAX_REACTION_EMOJI_LENGTH} characters` });
      }
      if (!sessionKey) {
        return res.status(400).json({ error: 'Session key is required' });
      }
      if (typeof sessionKey !== 'string' || sessionKey.length > MAX_REACTION_SESSION_KEY_LENGTH) {
        return res.status(400).json({ error: `Session key must be a string of at most ${MAX_REACTION_SESSION_KEY_LENGTH} characters` });
      }

      // Normalize shortcode emoji (e.g. :thumbsup:) to unicode through the
      // same helper the gateway reaction-event path uses, so both spellings
      // store under one (message_id, session_key, emoji, username) key.
      const emoji = normalizeReactionEmoji(rawEmoji);
      if (!emoji) {
        return res.status(400).json({ error: 'Emoji is required' });
      }
      if (emoji.length > MAX_REACTION_EMOJI_LENGTH) {
        return res.status(400).json({ error: `Emoji must be at most ${MAX_REACTION_EMOJI_LENGTH} characters` });
      }

      const result = reactions.toggle(messageId, sessionKey, emoji, username);
      res.json({ success: true, messageId, ...result });
    } catch (error) {
      console.error('Error toggling reaction:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createReactionsRoutes };
