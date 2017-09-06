"use strict";
(function discord_io(Discord){
var isNode = typeof(window) === "undefined" && typeof(navigator) === "undefined";
var CURRENT_VERSION = "3.0.0",
    GATEWAY_VERSION = 7,
    LARGE_THRESHOLD = 250,
    MAX_REQUESTS    = 5,
    CONNECT_WHEN    = null,
    Endpoints, Payloads;

if (isNode) {
    var Util        = require('util'),
        FS          = require('fs'),
        UDP         = require('dgram'),
        Zlib        = require('zlib'),
        DNS         = require('dns'),
        Stream      = require('stream'),
        EE          = require('events').EventEmitter,
        requesters  = {
            http:     require('http'),
            https:    require('https')
        },
        ChildProc   = require('child_process'),
        URL         = require('url'),
        //NPM Modules
        NACL        = require('tweetnacl'),
        Opus        = null;
}

/* --- Version Check --- */
try {
	CURRENT_VERSION = require('../package.json').version;
} catch(e) {}
if (!isNode) CURRENT_VERSION = CURRENT_VERSION + "-browser";

/**
 * Discord Client constructor
 * @class
 * @arg {Object} options
 * @arg {String} options.token - The token of the account you wish to log in with.
 * @arg {Number} [options.messageCacheLimit] - The amount of messages to cache in memory, per channel. Used for information on deleted/updated messages. The default is 50.
 * @arg {Array<Number>} [options.shard] - The shard array. The first index is the current shard ID, the second is the amount of shards that should be running.
 */
class DiscordClient extends (isNode ? EE : Object) {
	constructor(options) {
		if (!isNode) Emitter.call(this);
		if (!options || options.constructor.name !== 'Object') return console.error("An Object is required to create the discord.io client.");

		applyProperties(this, [
			["_ws", null],
			["_uIDToDM", {}],
			["_status", null],
			["_ready", false],
			["_vChannels", {}],
			["_messageCache", {}],
			["_connecting", false],
			["_mainKeepAlive", null],
			["_req", APIRequest.bind(this)],
			["_shard", validateShard(options.shard)],
			["_game", new Proxy( {name: null, type: null, url: null}, gameProxyHandler(this) )],
			["_messageCacheLimit", typeof(options.messageCacheLimit) === 'number' ? options.messageCacheLimit : 50],
		]);
		
		this.connected = false;
		this.inviteURL = null;
	}

	get status() {
		return this._status;
	}
	set status(v) {
		if ( Object.values(Discord.Status).indexOf(v) < 0 ) return;
		return ws_send( this._ws, Payloads.STATUS(this._status = v, this._game) );
	}

	get game() {
		return this._game;
	}
	set game(v) {
		if (typeof(v) !== 'object') return;
		
		if (v === null) return DiscordClient.GAME_KEYS.forEach( key => this._game[key] = null );
		return DiscordClient.GAME_KEYS.forEach( key => v.hasOwnProperty(key) && (this._game[key] = v[key]) );
	}

	/**
	 * Manually initiate the WebSocket connection to Discord.
	 */
	connect() {
		if (!this.connected && !this._connecting) return setTimeout(function() {
			init(this);
			CONNECT_WHEN = Math.max(CONNECT_WHEN, Date.now()) + 6000;
		}, Math.max( 0, CONNECT_WHEN - Date.now() ));
		return this;
	}

	/**
	 * Disconnect the WebSocket connection to Discord.
	 */
	disconnect() {
		if (this._ws) this._ws.close();
		return this;
	}

	/**
	 * Receive OAuth information for the current client.
	 */
	getOauthInfo() {
		return this._req('get', Endpoints.OAUTH);
	}

	/**
	 * Receive account settings information for the current client.
	 */
	getAccountSettings() {
		return this._req('get', Endpoints.SETTINGS);
	}

	/**
	 * Send a message to a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.to - The target Channel or User ID.
	 * @arg {String} input.content - The message content.
	 * @arg {Object} [input.embed] - An embed object to include
	 * @arg {Boolean} [input.tts] - Enable Text-to-Speech for this message.
	 */
	sendMessage(input) {
		var message = generateMessage(input.content || '', input.embed);
		message.tts = (input.tts === true);

		return sendMessage(this, input.to, message, callback);
	}

	/**
	 * Upload a file to a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.to - The target Channel or User ID.
	 * @arg {Buffer} input.buffer - A Buffer containing the file data, or a String that's a path to the file.
	 * @arg {String} input.name - A filename for the uploaded file, required if you provide a Buffer.
	 * @arg {String} input.content - An optional message to provide.
	 */
	uploadFile(input) {
		var multi, message;

		multi = new Multipart();
		message = generateMessage(input.content || "");

		if (!bufferLike(input.buffer)) return Promise.reject(new TypeError("buffer field is not of type Uint8Array or Buffer"));

		[
			["content", message.content],
			["mentions", ""],
			["tts", false],
			["nonce", message.nonce],
			["file", file, input.name]
		].forEach(multi.append, multi);
		multi.finalize();

		return resolveID(this, input.to)
			.then(function(channelID) {
				return this.req('post', Endpoints.MESSAGES(channelID), multi);
			});

		/*resolveID(client, input.to, function(channelID) {
			client._req('post', Endpoints.MESSAGES(channelID), multi, function(err, res) {
				handleResCB("Unable to upload file", err, res, callback);
			});
		});*/
	}

	/**
	 * Pull a message object from Discord.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID - The channel ID that the message is from.
	 * @arg {Snowflake} input.messageID - The ID of the message.
	 */
	getMessage(input) {
		return this._req('get', Endpoints.MESSAGES(input.channelID, input.messageID))
		.then( m => new Message(this, m) );
	}

	/**
	 * Pull an array of message objects from Discord.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID - The channel ID to pull the messages from.
	 * @arg {Number} [input.amount] - How many messages to pull, defaults to 50.
	 * @arg {Snowflake} [input.before] - Pull messages before this message ID.
	 * @arg {Snowflake} [input.after] - Pull messages after this message ID.
	 */
	getMessages(input) {
		var client, messages, lastMessageID, qs, total;
		
		client = this;
		messages = [];
		lastMessageID = "";
		qs = {};
		total = typeof(input.amount) !== 'number' ? 50 : input.amount;

		if (input.before) qs.before = input.before;
		if (input.after) qs.after = input.after;

		return new Promise(function(resolve, reject) {
			(function getMessages() {
				if (total > 100) {
					qs.limit = 100;
					total = total - 100;
				} else {
					qs.limit = total;
				}

				if (messages.length >= input.amount) return resolve(messages.map( m => new Message(client, m) ));

				client._req('get', Endpoints.MESSAGES(input.channelID) + qstringify(qs))
					.then(function(r_messages) {
						messages = messages.concat(r_messages);
						lastMessageID = messages[messages.length - 1] && messages[messages.length - 1].id;
						if (lastMessageID) qs.before = lastMessageID;
						if (res.body.length < qs.limit) return resolve(messages.map( m => new Message(client, m) ));
						return setTimeout(getMessages, 1000);
					}).catch(function(error) {
						return reject(new ResponseError(error));
					});
			})();
		});
	}

	/**
	 * Edit a previously sent message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 * @arg {String} input.message - The new message content
	 * @arg {Object} [input.embed] - The new Discord Embed object
	 */
	editMessage(input) {
		return this._req('patch', Endpoints.MESSAGES(input.channelID, input.messageID), generateMessage(input.content || '', input.embed))
			.then( m => new Message(this, m) );
	}

	/**
	 * Delete a posted message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 */
	deleteMessage(input) {
		var [messageID, channelID] = (input instanceof Message) ? 
			[input.id, input.channel.id] : 
			[input.messageID, input.channelID];
		
		return this._req('delete', Endpoints.MESSAGES(channelID, messageID));
	}

	/**
	 * Delete a batch of messages.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Array<Snowflake>} input.messageIDs - An Array of message IDs, with a maximum of 100 indexes.
	 */
	deleteMessages(input) {
		var client, copy;
		
		client = this;
		copy = input.messageIDs.slice();
		
		return new Promise(function(resolve, reject) {
			(function _deleteMessages() {
				if (copy.length <= 0) return resolve();
				var slice = copy.splice(0, 100);
				client._req('post', Endpoints.BULK_DELETE(input.channelID), {messages: slice})
					.then(_deleteMessages)
					.catch(reject);
			})();
		});
	}

	/**
	 * Pin a message to the channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 */
	pinMessage(input) {
		return this._req('put', Endpoints.PINNED_MESSAGES(input.channelID, input.messageID));
	}

	/**
	 * Get an array of pinned messages from a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 */
	getPinnedMessages(input) {
		return this._req('get', Endpoints.PINNED_MESSAGES(input.channelID));
	}

	/**
	 * Delete a pinned message from a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 */
	unpinMessage(input) {
		return this._req('delete', Endpoints.PINNED_MESSAGES(input.channelID, input.messageID));
	}

	/**
	 * Send 'typing...' status to a channel
	 * @arg {Snowflake} channelID
	 */
	simulateTyping(channelID) {
		return this._req('post', Endpoints.TYPING(channelID));
	}

	/**
	 * Add an emoji reaction to a message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 * @arg {String} input.reaction - Either the emoji unicode or the emoji name:id/object.
	 */
	addReaction(input) {
		return this._req('put', Endpoints.USER_REACTIONS(input.channelID, input.messageID, stringifyEmoji(input.reaction)));
	}

	/**
	 * Get an emoji reaction of a message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 * @arg {String} input.reaction - Either the emoji unicode or the emoji name:id/object.
	 * @arg {String} [input.limit]
	 */
	getReaction(input) {
		var qs = { limit: (typeof(input.limit) !== 'number' ? 100 : input.limit) };
		return this._req('get', Endpoints.MESSAGE_REACTIONS(input.channelID, input.messageID, stringifyEmoji(input.reaction)) + qstringify(qs));
	}

	/**
	 * Remove an emoji reaction from a message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 * @arg {Snowflake} [input.userID]
	 * @arg {String} input.reaction - Either the emoji unicode or the emoji name:id/object.
	 */
	removeReaction(input) {
		return this._req('delete', Endpoints.USER_REACTIONS(input.channelID, input.messageID, stringifyEmoji(input.reaction), input.userID));
	}

	/**
	 * Remove all emoji reactions from a message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 */
	removeAllReactions(input) {
		return this._req('delete', Endpoints.MESSAGE_REACTIONS(input.channelID, input.messageID));
	}

	/**
	 * Remove a user from a server.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	kick(input) {
		return this._req('delete', Endpoints.MEMBERS(input.serverID, input.userID));
	}

	/**
	 * Remove and ban a user from a server.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 * @arg {Number} [input.lastDays] - Removes their messages up until this point, either 1 or 7 days.
	 */
	ban(input) {
		if (input.lastDays) {
			input.lastDays = Number(input.lastDays);
			input.lastDays = Math.min(input.lastDays, 7);
			input.lastDays = Math.max(input.lastDays, 1);
		}

		return this._req('put', Endpoints.BANS(input.serverID, input.userID) + (input.lastDays ? "?delete-message-days=" + input.lastDays : ""));
	}

	/**
	 * Unban a user from a server.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	unban(input) {
		return this._req('delete', Endpoints.BANS(input.serverID, input.userID));
	}

	/**
	 * Move a user between voice channels.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 * @arg {Snowflake} input.channelID
	 */
	moveUserTo(input) {
		return this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {channel_id: input.channelID});
	}

	/**
	 * Server-mute the user from speaking in all voice channels.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	mute(input) {
		return this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {mute: true});
	}

	/**
	 * Remove the server-mute from a user.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	unmute(input) {
		return this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {mute: false});
	}

	/**
	 * Server-deafan a user.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	deafen(input) {
		return this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {deaf: true});
	}

	/**
	 * Remove the server-deafan from a user.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	undeafen(input) {
		return this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {deaf: false});
	}

	/**
	 * Create a server [User only].
	 * @arg {Object} input
	 * @arg {String} input.name - The server's name
	 * @arg {String} [input.region] - The server's region code, check the Gitbook documentation for all of them.
	 * @arg {Buffer} [input.icon] - A Buffer of image data.
	 */
	createServer(input) {
		var payload, client, img_mime;
		
		payload = payload_object({icon: null, name: null, region: null}, input);
		client = this;

		if ( input.icon && (img_mime = image_type(input.icon)) ) {
			payload.icon = image_to_b64(img_mime, input.icon);
		}
		
		return client._req('post', Endpoints.SERVERS(), payload)
			.then( res => client.servers[res.body.id] = new Server(res.body) );
	}

	/**
	 * Edit server information.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {String} [input.name]
	 * @arg {Buffer} [input.icon]
	 * @arg {String} [input.region]
	 * @arg {Snowflake} [input.afk_channel_id] - The ID of the voice channel to move a user to after the afk period.
	 * @arg {Number} [input.afk_timeout] - Time in seconds until a user is moved to the afk channel. 60, 300, 900, 1800, or 3600.
	 */
	editServer(input) {
		var client, serverID, afk_channel_id, server, afk_channel, img_mime, payload;

		if (!this.servers[input.serverID]) return Promise.reject(
			new Error(`Server ${serverID} not found.`)
		);

		client = this;
		serverID = input.serverID;
		server = client.servers[serverID];
		payload = payload_object({
				name: server.name,
				icon: server.icon,
				region: server.region,
				afk_channel_id: server.afkChannelID,
				afk_timeout: server.afkTimeout
			},
			input
		);

		if (afk_channel_id = input['afk_channel_id']) {
			if (afk_channel = server.channels[afk_channel_id] && afk_channel.type === 'voice')
				payload['afk_channel_id'] = afk_channel_id;
		}
		if (input['afk_timeout']) {
			if ([60, 300, 900, 1800, 3600].indexOf( Number(input['afk_timeout']) ) > -1)
				payload['afk_timeout'] = input['afk_timeout'];
		}
		if ( input.icon && (img_mime = image_type(input.icon)) )
			payload.icon = image_to_b64(img_mime, input.icon);

		return client._req('patch', Endpoints.SERVERS(input.serverID), payload);
	}

	/**
	 * Edit the widget information for a server.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID - The ID of the server whose widget you want to edit.
	 * @arg {Boolean} [input.enabled] - Whether or not you want the widget to be enabled.
	 * @arg {Snowflake} [input.channelID] - [Important] The ID of the channel you want the instant invite to point to.
	 */
	editServerWidget(input) {
		var client, payload, url;

		client = this;
		url = Endpoint.SERVERS(input.serverID);

		client._req('get', url)
			.then(function(res) {
				payload = {
					enabled: ('enabled' in input ? input.enabled : res.body.enabled),
					channel_id: ('channelID' in input ? input.channelID : res.body.channel_id)
				};
			})
			.then(client._req.bind(client, 'patch', url, payload));
	}

	/**
	 * [User Account] Add an emoji to a server
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {String} input.name - The emoji's name
	 * @arg {Buffer} input.icon - The emoji's image data as a Buffer
	 */
	addServerEmoji(input) {
		var payload, img_mime;

		payload = payload_object({name: null, image: null}, input);
		
		if (input.icon && (img_mime = image_type(input.icon))) {
			payload.image = image_to_b64(img_mime, input.icon);
		}

		return this._req('post', Endpoints.SERVER_EMOJIS(input.serverID), payload);
	}

	/**
	 * [User Account] Edit a server emoji data (name only, currently)
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.emojiID - The emoji's ID
	 * @arg {String} [input.name]
	 * @arg {Array<Snowflake>} [input.roles] - An array of role IDs you want to limit the emoji's usage to
	 */
}

DiscordClient.GAME_KEYS = ['name', 'type', 'url'];

/**
 * [User Account] Edit a server emoji data (name only, currently)
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.emojiID - The emoji's ID
 * @arg {String} [input.name]
 * @arg {Array<Snowflake>} [input.roles] - An array of role IDs you want to limit the emoji's usage to
 */
DCP.editServerEmoji = function(input, callback) {
	var emoji, payload = {};
	if ( !this.servers[input.serverID] ) return handleErrCB(("Server not available: " + input.serverID), callback);
	if ( !this.servers[input.serverID].emojis[input.emojiID]) return handleErrCB(("Emoji not available: " + input.emojiID), callback);

	emoji = this.servers[input.serverID].emojis[input.emojiID];
	payload.name = input.name || emoji.name;
	payload.roles = input.roles || emoji.roles;

	this._req('patch', Endpoints.SERVER_EMOJIS(input.serverID, input.emojiID), payload, function(err, res) {
		handleResCB("Could not edit server emoji", err, res, callback);
	});
};

/**
 * [User Account] Remove an emoji from a server
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.emojiID
 */
DCP.deleteServerEmoji = function(input, callback) {
	this._req('delete', Endpoints.SERVER_EMOJIS(input.serverID, input.emojiID), function(err, res) {
		handleResCB("Could not delete server emoji", err, res, callback);
	});
};

/**
 * Leave a server.
 * @arg {Snowflake} serverID
 */
DCP.leaveServer = function(serverID, callback) {
	this._req('delete', Endpoints.SERVERS_PERSONAL(serverID), function(err, res) {
		handleResCB("Could not leave server", err, res, callback);
	});
};

/**
 * Delete a server owned by the client.
 * @arg {Snowflake} serverID
 */
DCP.deleteServer = function(serverID, callback) {
	this._req('delete', Endpoints.SERVERS(serverID), function(err, res) {
		handleResCB("Could not delete server", err, res, callback);
	});
};

/**
 * Transfer ownership of a server to another user.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 */
DCP.transferOwnership = function(input, callback) {
	this._req('patch', Endpoints.SERVERS(input.serverID), {owner_id: input.userID}, function(err, res) {
		handleResCB("Could not transfer server ownership", err, res, callback);
	});
};

/**
 * Generate an invite URL for a channel.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Number} [input.max_age] - Time in seconds.
 * @arg {Number} [input.max_users] - The amount of times the invite code can be used.
 * @arg {Boolean} [input.temporary] - Any users who use this invite will be removed when they disconnect, unless given a role.
 */
DCP.createInvite = function(input, callback) {
	var payload, client = this;

	payload = {
		max_age: 0,
		max_users: 0,
		temporary: false
	};

	if ( Object.keys(input).length === 1 && input.channelID ) {
		payload = {
			validate: client.internals.lastInviteCode || null
		};
	}

	for (var key in input) {
		if (Object.keys(payload).indexOf(key) < 0) continue;
		payload[key] = input[key];
	}

	this._req('post', Endpoints.CHANNEL(input.channelID) + "/invites", payload, function(err, res) {
		try {client.internals.lastInviteCode = res.body.code;} catch(e) {}
		handleResCB('Unable to create invite', err, res, callback);
	});
};

/**
 * Delete an invite code.
 * @arg {String} inviteCode
 */
DCP.deleteInvite = function(inviteCode, callback) {
	this._req('delete', Endpoints.INVITES(inviteCode), function(err, res) {
		handleResCB('Unable to delete invite', err, res, callback);
	});
};

/**
 * Get information on an invite.
 * @arg {String} inviteCode
 */
DCP.queryInvite = function(inviteCode, callback) {
	this._req('get', Endpoints.INVITES(inviteCode), function(err, res) {
		handleResCB('Unable to get information about invite', err, res, callback);
	});
};

/**
 * Get all invites for a server.
 * @arg {Snowflake} serverID
 */
DCP.getServerInvites = function(serverID, callback) {
	this._req('get', Endpoints.SERVERS(serverID) + "/invites", function(err, res) {
		handleResCB('Unable to get invite list for server' + serverID, err, res, callback);
	});
};

/**
 * Get all invites for a channel.
 * @arg {Snowflake} channelID
 */
DCP.getChannelInvites = function(channelID, callback) {
	this._req('get', Endpoints.CHANNEL(channelID) + "/invites", function(err, res) {
		handleResCB('Unable to get invite list for channel' + channelID, err, res, callback);
	});
};

/**
 * Create a channel.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {String} input.name
 * @arg {String} [input.type] - 'text' or 'voice', defaults to 'text.
 */
DCP.createChannel = function(input, callback) {
	var client = this, payload = {
		name: input.name,
		type: (['text', 'voice'].indexOf(input.type) < 0) ? 'text' : input.type
	};

	this._req('post', Endpoints.SERVERS(input.serverID) + "/channels", payload, function(err, res) {
		try {
			var serverID = res.body.guild_id;
			var channelID = res.body.id;

			client.channels[channelID] = new Channel( client, client.servers[serverID], res.body );
		} catch(e) {}
		handleResCB('Unable to create channel', err, res, callback);
	});
};

/**
 * Create a Direct Message channel.
 * @arg {Snowflake} userID
 */
DCP.createDMChannel = function(userID, callback) {
	var client = this;
	this._req('post', Endpoints.USER(client.id) + "/channels", {recipient_id: userID}, function(err, res) {
		if (!err && goodResponse(res)) client._uIDToDM[res.body.recipient.id] = res.body.id;
		handleResCB("Unable to create DM Channel", err, res, callback);
	});
};

/**
 * Delete a channel.
 * @arg {Snowflake} channelID
 */
DCP.deleteChannel = function(channelID, callback) {
	this._req('delete', Endpoints.CHANNEL(channelID), function(err, res) {
		handleResCB("Unable to delete channel", err, res, callback);
	});
};

/**
 * Edit a channel's information.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {String} [input.name]
 * @arg {String} [input.topic] - The topic of the channel.
 * @arg {Number} [input.bitrate] - [Voice Only] The bitrate for the channel.
 * @arg {Number} [input.position] - The channel's position on the list.
 * @arg {Number} [input.user_limit] - [Voice Only] Imposes a user limit on a voice channel.
 */
DCP.editChannelInfo = function(input, callback) {
	var channel, payload;

	try {
		channel = this.channels[input.channelID];
		payload = {
			name: channel.name,
			topic: channel.topic,
			bitrate: channel.bitrate,
			position: channel.position,
			user_limit: channel.user_limit
		};

		for (var key in input) {
			if (Object.keys(payload).indexOf(key) < 0) continue;
			if (+input[key]) {
				if (key === 'bitrate') {
					payload.bitrate = Math.min( Math.max( input.bitrate, 8000), 96000);
					continue;
				}
				if (key === 'user_limit') {
					payload.user_limit = Math.min( Math.max( input.user_limit, 0), 99);
					continue;
				}
			}
			payload[key] = input[key];
		}

		this._req('patch', Endpoints.CHANNEL(input.channelID), payload, function(err, res) {
			handleResCB("Unable to edit channel", err, res, callback);
		});
	} catch(e) {return handleErrCB(e, callback);}
};

/**
 * Edit (or creates) a permission override for a channel.
 * @arg {Object} input
 * @arg {Snowflake} channelID
 * @arg {Snowflake} [userID]
 * @arg {Snowflake} [roleID]
 * @arg {Array<Number>} allow - An array of permissions to allow. Discord.Permissions.XXXXXX.
 * @arg {Array<Number>} deny - An array of permissions to deny, same as above.
 * @arg {Array<Number>} default - An array of permissions that cancels out allowed and denied permissions.
 */
DCP.editChannelPermissions = function(input, callback) { //Will shrink this up later
	var payload, pType, ID, channel, permissions, allowed_values;
	if (!input.userID && !input.roleID) return handleErrCB("No userID or roleID provided", callback);
	if (!this.channels[input.channelID]) return handleErrCB(("No channel found for ID: " + input.channelID), callback);
	if (!input.allow && !input.deny && !input.default) return handleErrCB("No allow, deny or default array provided.", callback);

	pType = input.userID ? 'user' : 'role';
	ID = input[pType + "ID"];
	channel = this.channels[ input.channelID ];
	permissions = channel.permissions[pType][ID] || { allow: 0, deny: 0 };
	allowed_values = [0, 4, 28].concat((channel.type === 'text' ?
	[10, 11, 12, 13, 14, 15, 16, 17, 18] :
	[20, 21, 22, 23, 24, 25] ));

	//Take care of allow first
	if (type(input.allow) === 'array') {
		input.allow.forEach(function(perm) {
			if (allowed_values.indexOf(perm) < 0) return;
			if (hasPermission(perm, permissions.deny)) {
				permissions.deny = removePermission(perm, permissions.deny);
			}
			permissions.allow = givePermission(perm, permissions.allow);
		});
	}
	//Take care of deny second
	if (type(input.deny) === 'array') {
		input.deny.forEach(function(perm) {
			if (allowed_values.indexOf(perm) < 0) return;
			if (hasPermission(perm, permissions.allow)) {
				permissions.allow = removePermission(perm, permissions.allow);
			}
			permissions.deny = givePermission(perm, permissions.deny);
		});
	}
	//Take care of defaulting last
	if (type(input.default) === 'array') {
		input.default.forEach(function(perm) {
			if (allowed_values.indexOf(perm) < 0) return;
			permissions.allow = removePermission(perm, permissions.allow);
			permissions.deny = removePermission(perm, permissions.deny);
		});
	}

	payload = {
		type: (pType === 'user' ? 'member' : 'role'),
		id: ID,
		deny: permissions.deny,
		allow: permissions.allow
	};

	this._req('put', Endpoints.CHANNEL(input.channelID) + "/permissions/" + ID, payload, function(err, res) {
		handleResCB('Unable to edit permission', err, res, callback);
	});
};

/**
 * Delete a permission override for a channel.
 * @arg {Object} input
 * @arg {Snowflake} channelID
 * @arg {Snowflake} [userID]
 * @arg {Snowflake} [roleID]
 */
DCP.deleteChannelPermission = function(input, callback) {
	var payload, pType, ID;
	if (!input.userID && !input.roleID) return handleErrCB("No userID or roleID provided", callback);
	if (!this.channels[input.channelID]) return handleErrCB(("No channel found for ID: " + input.channelID), callback);

	pType = input.userID ? 'user' : 'role';
	ID = input[pType + "ID"];

	payload = {
		type: (pType === 'user' ? 'member' : 'role'),
		id: ID
	};

	this._req('delete', Endpoints.CHANNEL(input.channelID) + "/permissions/" + ID, payload, function(err, res) {
		handleResCB('Unable to delete permission', err, res, callback);
	});
};

/**
 * Create a role for a server.
 * @arg {Snowflake} serverID
 */
DCP.createRole = function(serverID, callback) {
	var client = this;
	this._req('post', Endpoints.ROLES(serverID), function(err, res) {
		try {
			client.servers[serverID].roles[res.body.id] = new Role(res.body);
		} catch(e) {}
		handleResCB("Unable to create role", err, res, callback);
	});
};

/**
 * Edit a role.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.roleID - The ID of the role.
 * @arg {String} [input.name]
 * @arg {String} [input.color] - A color value as a number. Recommend using Hex numbers, as they can map to HTML colors (0xF35353 === #F35353).
 * @arg {Boolean} [input.hoist] - Separates the users in this role from the normal online users.
 * @arg {Object} [input.permissions] - An Object containing the permission as a key, and `true` or `false` as its value. Read the Permissions doc.
 * @arg {Boolean} [input.mentionable] - Toggles if users can @Mention this role.
 */
DCP.editRole = function(input, callback) {
	var role, payload;
	try {
		role = new Role(this.servers[input.serverID].roles[input.roleID]);
		payload = {
			name: role.name,
			color: role.color,
			hoist: role.hoist,
			permissions: role._permissions,
			mentionable: role.mentionable,
			position: role.position
		};

		for (var key in input) {
			if (Object.keys(payload).indexOf(key) < 0) continue;
			if (key === 'permissions') {
				for (var perm in input[key]) {
					role[perm] = input[key][perm];
					payload.permissions = role._permissions;
				}
				continue;
			}
			if (key === 'color') {
				if (String(input[key])[0] === '#') payload.color = parseInt(String(input[key]).replace('#', '0x'), 16);
				if (Discord.Colors[input[key]]) payload.color = Discord.Colors[input[key]];
				if (type(input[key]) === 'number') payload.color = input[key];
				continue;
			}
			payload[key] = input[key];
		}
		this._req('patch', Endpoints.ROLES(input.serverID, input.roleID), payload, function(err, res) {
			handleResCB("Unable to edit role", err, res, callback);
		});
	} catch(e) {return handleErrCB(e, callback);}
};

/**
 * Delete a role.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.roleID
 */
DCP.deleteRole = function(input, callback) {
	this._req('delete', Endpoints.ROLES(input.serverID, input.roleID), function(err, res) {
		handleResCB("Could not remove role", err, res, callback);
	});
};

/**
 * Add a user to a role.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.roleID
 * @arg {Snowflake} input.userID
 */
DCP.addToRole = function(input, callback) {
	this._req('put', Endpoints.MEMBER_ROLES(input.serverID, input.userID, input.roleID), function(err, res) {
		handleResCB("Could not add role", err, res, callback);
	});
};

/**
 * Remove a user from a role.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.roleID
 * @arg {Snowflake} input.userID
 */
DCP.removeFromRole = function(input, callback) {
	this._req('delete', Endpoints.MEMBER_ROLES(input.serverID, input.userID, input.roleID), function(err, res) {
		handleResCB("Could not remove role", err, res, callback);
	});
};

/**
 * Edit a user's nickname.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 * @arg {String} input.nick - The nickname you'd like displayed.
 */
DCP.editNickname = function(input, callback) {
	var payload = {nick: String( input.nick ? input.nick : "" )};
	var url = input.userID === this.id ?
		Endpoints.MEMBERS(input.serverID) + "/@me/nick" :
		Endpoints.MEMBERS(input.serverID, input.userID);

	this._req('patch', url, payload, function(err, res) {
		handleResCB("Could not change nickname", err, res, callback);
	});
};

/**
 * Edit a user's note.
 * @arg {Object} input
 * @arg {Snowflake} input.userID
 * @arg {String} input.note - The note content that you want to use.
 */
DCP.editNote = function(input, callback) {
	this._req('put', Endpoints.NOTE(input.userID), {note: input.note}, function(err, res) {
		handleResCB("Could not edit note", err, res, callback);
	});
};

/**
 * Retrieve a user object from Discord, the library already caches users, however.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 */
DCP.getMember = function(input, callback) {
	this._req('get', Endpoints.MEMBERS(input.serverID, input.userID), function(err, res) {
		handleResCB("Could not get member", err, res, callback);
	});
};

/**
 * Retrieve a group of user objects from Discord.
 * @arg {Object} input
 * @arg {Number} [input.limit] - The amount of users to pull, defaults to 50.
 * @arg {Snowflake} [input.after] - The offset using a user ID.
 */
DCP.getMembers = function(input, callback) {
	var qs = {};
	qs.limit = (typeof(input.limit) !== 'number' ? 50 : input.limit);
	if (input.after) qs.after = input.after;

	this._req('get', Endpoints.MEMBERS(input.serverID) + qstringify(qs), function(err, res) {
		handleResCB("Could not get members", err, res, callback);
	});
};

/**
 * Get the ban list from a server
 * @arg {Snowflake} serverID
 */
DCP.getBans = function(serverID, callback) {
	this._req('get', Endpoints.BANS(serverID), function(err, res) {
		handleResCB("Could not get ban list", err, res, callback);
	});
};

/**
 * Get all webhooks for a server
 * @arg {Snowflake} serverID
 */
DCP.getServerWebhooks = function(serverID, callback) {
	this._req('get', Endpoints.SERVER_WEBHOOKS(serverID), function(err, res) {
		handleResCB("Could not get server Webhooks", err, res, callback);
	});
};

/**
 * Get webhooks from a channel
 * @arg {Snowflake} channelID
 */
DCP.getChannelWebhooks = function(channelID, callback) {
	this._req('get', Endpoints.CHANNEL_WEBHOOKS(channelID), function(err, res) {
		handleResCB("Could not get channel Webhooks", err, res, callback);
	});
};

/**
 * Create a webhook for a server
 * @arg {Snowflake} serverID
 */
DCP.createWebhook = function(serverID, callback) {
	this._req('post', Endpoints.SERVER_WEBHOOKS(serverID), function(err, res) {
		handleResCB("Could not create a Webhook", err, res, callback);
	});
};

/**
 * Edit a webhook
 * @arg {Object} input
 * @arg {Snowflake} input.webhookID - The Webhook's ID
 * @arg {String} [input.name]
 * @arg {String<Base64>} [input.avatar]
 * @arg {String} [input.channelID]
 */
DCP.editWebhook = function(input, callback) {
	var client = this, payload = {}, allowed = ['avatar', 'name'];
	this._req('get', Endpoints.WEBHOOKS(input.webhookID), function(err, res) {
		if (err || !goodResponse(res)) return handleResCB("Couldn't get webhook, do you have permissions to access it?", err, res, callback);
		allowed.forEach(function(key) {
			payload[key] = (key in input ? input[key] : res.body[key]);
		});
		payload.channel_id = input.channelID || res.body.channel_id;

		client._req('patch', Endpoints.WEBHOOKS(input.webhookID), payload, function(err, res) {
			return handleResCB("Couldn't update webhook", err, res, callback);
		});
	});
};

/* --- Voice --- */

/**
 * Join a voice channel.
 * @arg {Snowflake} channelID
 */
DCP.joinVoiceChannel = function(channelID, callback) {
	var serverID, server, channel, voiceSession;
	try {
		serverID = this.channels[channelID].guild_id;
		server = this.servers[serverID];
		channel = server.channels[channelID];
	} catch(e) {}
	if (!serverID) return handleErrCB(("Cannot find the server related to the channel provided: " + channelID), callback);
	if (channel.type !== 'voice') return handleErrCB(("Selected channel is not a voice channel: " + channelID), callback);
	if (this._vChannels[channelID]) return handleErrCB(("Voice channel already active: " + channelID), callback);

	voiceSession = getVoiceSession(this, channelID, server);
	checkVoiceReady(voiceSession, callback);
	return ws_send(this._ws, Payloads.UPDATE_VOICE(serverID, channelID));
};

/**
 * Leave a voice channel.
 * @arg {Snowflake} channelID
 */
DCP.leaveVoiceChannel = function(channelID, callback) {
	if (!this._vChannels[channelID]) return handleErrCB(("Not in the voice channel: " + channelID), callback);
	return leaveVoiceChannel(this, channelID, callback);
};

/**
 * Prepare the client for sending/receiving audio.
 * @arg {Snowflake|Object} channelObj - Either the channel ID, or an Object with `channelID` as a key and the ID as the value.
 * @arg {Number} [channelObj.maxStreamSize] - The size in KB that you wish to receive before pushing out earlier data. Required if you want to store or receive incoming audio.
 * @arg {Boolean} [channelObj.stereo] - Sets the audio to be either stereo or mono. Defaults to true.
 */
DCP.getAudioContext = function(channelObj, callback) {
	// #q/qeled gave a proper timing solution. Credit where it's due.
	if (!isNode) return handleErrCB("Using audio in the browser is currently not supported.", callback);
	var channelID = channelObj.channelID || channelObj, voiceSession = this._vChannels[channelID], encoder = chooseAudioEncoder(['ffmpeg', 'avconv']);

	if (!voiceSession) return handleErrCB(("You have not joined the voice channel: " + channelID), callback);
	if (voiceSession.ready !== true) return handleErrCB(("The connection to the voice channel " + channelID + " has not been initialized yet."), callback);
	if (!encoder) return handleErrCB("You need either 'ffmpeg' or 'avconv' and they need to be added to PATH", callback);

	voiceSession.audio = voiceSession.audio || new AudioCB(
		voiceSession,
		channelObj.stereo === false ? 1 : 2,
		encoder,
		Math.abs(Number(channelObj.maxStreamSize)));

	return call(callback, [null, voiceSession.audio]);
};

/* --- Misc --- */

/**
 * Retrieves all offline (and online, if using a user account) users, fires the `allUsers` event when done.
 */
DCP.getAllUsers = function(callback) {
	var servers = Object.keys(this.servers).filter(function(s) {
			s = this.servers[s];
			if (s.members) return s.member_count !== Object.keys(s.members).length && (this.bot ? s.large : true);
		}, this);

	if (!servers[0]) {
		this.emit('allUsers');
		return handleErrCB("There are no users to be collected", callback);
	}
	if (!this.bot) ws_send(this._ws, Payloads.ALL_USERS(this));

	return getOfflineUsers(this, servers, callback);
};

class Server {
	constructor(client) {
		this.client = client;
	}
}
class Channel {}
class Message {
	/*{
		"nonce": "321839920844898304", 
		"attachments": [], 
		"tts": false, 
		"embeds": [], 
		"timestamp": "2017-06-07T02:36:57.334000+00:00", 
		"mention_everyone": false, 
		"id": "321839923814727691", 
		"pinned": false, 
		"edited_timestamp": null, 
		"author": {
			"username": "izy521", 
			"discriminator": "7800", 
			"id": "66186356581208064", 
			"avatar": "1a507cce78feea31be65af80c9808232"
		}, 
		"mention_roles": [], 
		"content": "as usual", 
		"channel_id": "81384788765712384", 
		"mentions": [], 
		"type": 0
	}*/
	constructor() {
		
	}
}


/* --- Functions --- */
function payload_object(base_object, modified_object) {
	return Object.assign(Object.seal(base_object), modified_object);
}

function handleErrCB(err, callback) {
	if (!err) return false;
	return call(callback, [new Error(err)]);
}
function handleResCB(errMessage, err, res, callback) {
	if (typeof(callback) !== 'function') return;
	res = res || {};
	if (!err && goodResponse(res)) return (callback(null, res.body), true);

	var e = new Error( err || errMessage );
	e.name = "ResponseError";
	e.statusCode = res.statusCode;
	e.statusMessage = res.statusMessage;
	e.response = res.body;
	return (callback(e), false);
}
function goodResponse(response) {
	return (response.statusCode / 100 | 0) === 2;
}
function stringifyError(response) {
	if (!response) return null;
	return response.statusCode + " " + response.statusMessage + "\n" + JSON.stringify(response.body);
}

/* - Functions - Messages - */
function sendMessage(client, to, message, callback) {
	resolveID(client, to, function(channelID) {
		client._req('post', Endpoints.MESSAGES(channelID), message, function(err, res) {
			handleResCB("Unable to send messages", err, res, callback);
		});
	});
}
function cacheMessage(cache, limit, channelID, message) {
	if (!cache[channelID]) cache[channelID] = {};
	if (limit === -1) return void(cache[channelID][message.id] = message);
	var k = Object.keys(cache[channelID]);
	if (k.length > limit) delete(cache[channelID][k[0]]);
	cache[channelID][message.id] = message;
}
function generateMessage(message, embed) {
	var m = { content: String(message) };
	if (embed) m.embed = embed;
	return m;
}
function messageHeaders(client) {
	var r = {
		"accept": "*/*",
		"accept-language": "en-US;q=0.8",
	};
	if (isNode) {
		r["accept-encoding"] = "gzip, deflate";
		r.user_agent = "DiscordBot (https://github.com/izy521/discord.io, " + CURRENT_VERSION + ")";
		r.dnt = 1;
	}
	try {
		r.authorization = (client.bot ? "Bot " : "") + client.internals.token;
	} catch(e) {}
	return r;
}
function stringifyEmoji(emoji) {
	if (typeof emoji === 'object') // if (emoji.name && emoji.id)
		return emoji.name + ':' + emoji.id;
	if (emoji.indexOf(':') > -1)
		return emoji;
	return encodeURIComponent(decodeURIComponent(emoji));
}

/* - Functions - Utils */
function APIRequest(method, url, data) {
	var data, opts, req, headers = messageHeaders(this);

	return new Promise(function(resolve, reject) {
		if (isNode) {
			opts = URL.parse(url);
			opts.method = method;
			opts.headers = headers;

			req = requesters[opts.protocol.slice(0, -1)].request(opts, function(res) {
				var chunks = [];
				res
					.on('data', c => chunks[chunks.length] = c)
					.once('end', function() {
						chunks = Buffer.concat(chunks);
						try {
							return resolve(Zlib.gunzipSync(chunks));
						} catch (e) {
							return resolve(chunks);
						}
					});
			});
			if (type(data) === 'object' || method.toLowerCase() === 'get') req.setHeader("Content-Type", "application/json; charset=utf-8");
			if (data instanceof Multipart) req.setHeader("Content-Type", "multipart/form-data; boundary=" + data.boundary);
			if (data) req.write(data.result || JSON.stringify(data), data.result ? 'binary' : 'utf-8');
			return req.once('error', e => reject(e.message)).end();
		}


	});
}
function APIRequest(method, url) {
	var data, callback, opts, req, headers = messageHeaders(this);
	callback = ( typeof(arguments[2]) === 'function' ? arguments[2] : (data = arguments[2], arguments[3]) );

	if (isNode) {
		opts = URL.parse(url);
		opts.method = method;
		opts.headers = headers;

		req = requesters[opts.protocol.slice(0, -1)].request(opts, function(res) {
			var chunks = [];
			res.on('data', function(c) { chunks[chunks.length] = c; });
			res.once('end', function() {
				chunks = Buffer.concat(chunks);
				Zlib.gunzip(chunks, function(err, uc) {
					if (!err) uc = uc.toString();
					try { res.body = JSON.parse(uc || chunks); } catch(e) {}
					return callback(null, res);
				});
			});
		});
		if (type(data) === 'object' || method.toLowerCase() === 'get') req.setHeader("Content-Type", "application/json; charset=utf-8");
		if (data instanceof Multipart) req.setHeader("Content-Type", "multipart/form-data; boundary=" + data.boundary);
		if (data) req.write( data.result || JSON.stringify(data), data.result ? 'binary' : 'utf-8' );
		req.end();

		return req.once('error', function(e) { return callback(e.message); });
	}

	req = new XMLHttpRequest();
	req.open(method.toUpperCase(), url, true);
	for (var key in headers) {
		req.setRequestHeader(key, headers[key]);
	}
	req.onreadystatechange = function() {
		if (req.readyState == 4) {
			req.statusCode = req.status;
			req.statusMessage = req.statusText;
			try {req.body = JSON.parse(req.responseText);} catch (e) { return handleErrCB(e, callback); }
			callback(null, req);
		}
	};
	if (type(data) === 'object' || method.toLowerCase() === 'get') req.setRequestHeader("Content-Type", "application/json; charset=utf-8");
	if (data instanceof Multipart) req.setRequestHeader("Content-Type", "multipart/form-data; boundary=" + data.boundary);
	if (data) return req[ (data.result ? "sendAsBinary" : "send") ]( data.result ? data.result : JSON.stringify(data) );
	req.send(null);
}
function ws_send(ws, data) {
	if (ws && ws.readyState == 1) ws.send(JSON.stringify(data));
}
function copy(obj) {
	try {
		return JSON.parse( JSON.stringify( obj ) );
	} catch(e) {}
}
function copyKeys(from, to, omit) {
	if (!omit) omit = [];
	for (var key in from) {
		if (omit.indexOf(key) > -1) continue;
		to[key] = from[key];
	}
}
function applyProperties(object, properties) {
	properties.forEach(function(t) {
		Object.defineProperty(object, t[0], {
			configurable: true,
			writable: true,
			value: t[1]
		});
	}, object);
}
function type(v) {
	return Object.prototype.toString.call(v).match(/ (.*)]/)[1].toLowerCase();
}
function call(f, a) {
	if (typeof(f) != 'function') return;
	return f.apply(null, a);
}
function qstringify(obj) {
	//.map + .join is 7x slower!
	var i=0, s = "", k = Object.keys(obj);
	for (i;i<k.length;i++) {
		s += k[i] + "=" + obj[k[i]] + "&";
	}
	return "?" + s.slice(0, -1);
}
function emit(client, message) {
	if (!message.t) return;
	var t = message.t.split("_"), i = 1, args = [t[0].toLowerCase()];

	for (i; i<t.length; i++) {
		args[0] += t[i][0] + t[i].slice(1).toLowerCase();
	}
	for (i=2; i<arguments.length; i++) {
		args.push(arguments[i]);
	}
	args.push(message);
	client.emit.apply(client, args);
}
function decompressWSMessage(m, f) {
	f = f || {};
	return f.binary ? JSON.parse(Zlib.inflateSync(m).toString()) : JSON.parse(m);
}
function removeAllListeners(emitter, type) {
	if (!emitter) return;
	var e = emitter._evts, i, k, o, s, z;
	if (isNode) return type ? emitter.removeAllListeners(type) : emitter.removeAllListeners();

	if (type && e[type]) {
		for (i=0; i<e[type].length; i++) {
			emitter.removeListener(type, e[type][i]);
		}
	}

	if (!type) {
		k = Object.keys(e);
		for (o=0; o<k.length; o++) {
			s = e[ k[o] ];
			for (z=0; z<s.length; z++) {
				emitter.removeListener(k[o], s[z]);
			}
		}
	}
}
function colorFromRole(server, member) {
	return member.roles.reduce(function(array, ID) {
		var role = server.roles[ID];
		if (!role) return array;
		return role.position > array[0] && role.color ? [role.position, role.color] : array;
	}, [-1, null])[1];
}
function image_type(buffer) {
	var i, types = ['jpeg', 'png', 'gif'];

	(
		buffer[0] === 0xFF &&
		buffer[1] === 0xD8 &&
		buffer[buffer.length - 1] === 0xD9 &&
		buffer[buffer.length - 2] === 0xFF
	) && (i = 0);

	[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
		.every((b, i) => buffer[i] === b) && (i = 1);

	(
		buffer[0] === 0x47 &&
		buffer[1] === 0x49 &&
		buffer[2] === 0x46 &&
		buffer[3] === 0x38 &&
		([0x39, 0x37].indexOf(buffer[4]) > -1) &&
		buffer[5] === 0x61
	) && (i = 2);

	return typeof (i) === 'number' ? types[i] : undefined;
}
function image_to_b64(mime, buffer) {
	return `data:image/${mime};base64,${buffer.toString('base64')}`
}

function gameProxyHandler(client) {
	var changeTimeout = null;
	return {
		set: function(object, name, value) {
			if (DiscordClient.GAME_KEYS.indexOf(name) < 0) return;
			if (changeTimeout) clearInterval(changeTimeout);

			object[name] = value;
			changeTimeout = setTimeout(function() {
				ws_send( client._ws, Payloads.STATUS(client._status, client._game) );
				changeTimeout = null;
			}, 1500);
		}
	};
}
function bufferLike(b) {
	return b instanceof Uint8Array || (Buffer && Buffer.isBuffer(b));
}

function givePermission(bit, permissions) {
	return permissions | (1 << bit);
}
function removePermission(bit, permissions) {
	return permissions & ~(1 << bit);
}
function hasPermission(bit, permissions) {
	return ((permissions >> bit) & 1) == 1;
}
//For the Getters and Setters
function getPerm(bit) {
	return function() {
		return ((this._permissions >> bit) & 1) == 1;
	};
}
function setPerm(bit) {
	return function(v) {
		if (v === true) return this._permissions |= (1 << (bit));
		if (v === false) return this._permissions &= ~(1 << bit);
	};
}

function getServerInfo(client, servArr) {
	for (var server=0; server<servArr.length; server++) {
		client.servers[servArr[server].id] = new Server(client, servArr[server]);
	}
}
function getDirectMessages(client, DMArray) {
	for (var DM=0; DM<DMArray.length; DM++) {
		client.directMessages[DMArray[DM].id] = new DMChannel(client._uIDToDM, DMArray[DM]);
	}
}
function resolveID(client, ID, callback) {
	/*Get channel from ServerID, ChannelID or UserID.
	Only really used for sendMessage and uploadFile.*/
	//Callback used instead of return because requesting seems necessary.

	if (client._uIDToDM[ID]) return callback(client._uIDToDM[ID]);
	//If it's a UserID, and it's in the UserID : ChannelID cache, use the found ChannelID

	//If the ID isn't in the UserID : ChannelID cache, let's try seeing if it belongs to a user.
	if (client.users[ID]) return client.createDMChannel(ID, function(err, res) {
		if (err) return console.log("Internal ID resolver error: " + JSON.stringify(err));
		callback(res.id);
	});

	return callback(ID); //Finally, the ID must not belong to a User, so send the message directly to it, as it must be a Channel's.
}
function resolveEvent(e) {
	return e.detail || ([e.data][0] ? [e.data] : [e.code]);
}

/* --- Initializing --- */
function init(client, opts) {
	client.servers = {};
	client.channels = {};
	client.users = {};
	client.directMessages = {};
	client.internals = {
		oauth: {}, settings: {}
	};
	client._connecting = true;

	setupPing(client.internals);
	return getToken(client, opts);
}
function getToken(client, opts) {
	if (opts.token) return getGateway(client, opts.token);
	if (!isNode) {
		//Read from localStorage? Sounds like a bad idea, but I'll leave this here.
	}
}
function getGateway(client, token) {
	client.internals.token = token;

	return APIRequest('get', Endpoints.GATEWAY, function (err, res) {
		if (err || !goodResponse(res)) {
			client._connecting = false;
			return client.emit("disconnect", "Error GETing gateway:\n" + stringifyError(res), 0);
		}
		return startConnection(client, (res.body.url + "/?encoding=json&v=" + GATEWAY_VERSION));
	});
}
function startConnection(client, gateway) {
	client._ws = new Websocket(gateway);
	client.internals.gatewayUrl = gateway;

	client._ws.once('close', handleWSClose.bind(client));
	client._ws.once('error', handleWSClose.bind(client));
	client._ws.on('message', handleWSMessage.bind(client));
}
function getOfflineUsers(client, servArr, callback) {
	if (!servArr[0]) return call(callback);

	ws_send(client._ws, Payloads.OFFLINE_USERS(servArr));
	return setTimeout( getOfflineUsers, 0, client, servArr, callback );
}
function checkForAllServers(client, ready, message) {
	var all = Object.keys(client.servers).every(function(s) {
		return !client.servers[s].unavailable;
	});
	if (all || ready[0]) return void(client._ready = true && client.emit('ready', message));
	return setTimeout(checkForAllServers, 0, client, ready, message);
}
function setupPing(obj) {
	applyProperties(obj, [
		["_pings", []],
		["_lastHB", 0]
	]);
	Object.defineProperty(obj, 'ping', {
		get: function() {
			return ((obj._pings.reduce(function(p, c) { return p + c; }, 0) / obj._pings.length) || 0) | 0;
		},
		set: function() {}
	});
}
function validateShard(shard) {
	return (
		type(shard)  === 'array' &&
		shard.length === 2       &&
		shard[0] <= shard[1]     &&
		shard[1] > 1
	) ? shard : null;
}
function identifyOrResume(client) {
	var payload, internals = client.internals;

	if (internals.sequence && internals.token && internals.sessionID) {
		payload = Payloads.RESUME(client);
	} else {
		payload = Payloads.IDENTIFY(client);
		if (client._shard) payload.d.shard = client._shard;
	}
	client._connecting = false;

	return ws_send(client._ws, payload);
}

/* - Functions - Websocket Handling - */
function handleWSMessage(data, flags) {
	var message = decompressWSMessage(data, flags);
	var _data = message.d;
	var client = this, user, server, member, old,
	userID, serverID, channelID, currentVCID;
	client.internals.sequence = message.s;

	switch (message.op) {
		case 9:
			//Invalid Session
			break;
		case 10:
			//Start keep-alive interval
			//Disconnect the client if no ping has been received
			//in 15 seconds (I think that's a decent duration)
			//Since v3 you the IDENTIFY/RESUME payload here.
			identifyOrResume(client);
			client.presenceStatus = 'online';
			client.connected = true;

			client._mainKeepAlive = setInterval(function() {
				client.internals.heartbeat = setTimeout(client._ws.close.bind(client._ws, 1e3, 'No heartbeat received'), 15e3);
				client.internals._lastHB = Date.now();
				ws_send(client._ws, Payloads.HEARTBEAT(client));
			}, _data.heartbeat_interval);
			break;
		case 11:
			clearTimeout(client.internals.heartbeat);
			client.internals._pings.unshift(Date.now() - client.internals._lastHB);
			client.internals._pings = client.internals._pings.slice(0, 10);
			break;
	}

	//Events
	client.emit('any', message);
	switch (message.t) {
		case "READY":
			copyKeys(_data.user, client);
			client.internals.sessionID = _data.session_id;

			getServerInfo(client, _data.guilds);
			getDirectMessages(client, _data.private_channels);

			if (client.bot) client.getOauthInfo(function(err, res) {
				if (err) return console.log(err);
				client.internals.oauth = res;
				client.inviteURL = "https://discordapp.com/oauth2/authorize?client_id=" + res.id + "&scope=bot";
			});
			if (!client.bot) client.getAccountSettings(function(err, res) {
				if (err) return console.log(err);
				client.internals.settings = res;
			});

			return (function() {
				if (client._ready) return;
				var ready = [false];
				setTimeout(function() { ready[0] = true; }, 3500);
				checkForAllServers(client, ready, message);
			})();
		case "MESSAGE_CREATE":
			client.emit('message', _data.author.username, _data.author.id, _data.channel_id, _data.content, message);
			emit(client, message, _data.author.username, _data.author.id, _data.channel_id, _data.content);
			return cacheMessage(client._messageCache, client._messageCacheLimit, _data.channel_id, _data);
		case "MESSAGE_UPDATE":
			try {
				emit(client, message, client._messageCache[_data.channel_id][_data.id], _data);
			} catch (e) { emit(client, message, undefined, _data); }
			return cacheMessage(client._messageCache, client._messageCacheLimit, _data.channel_id, _data);
		case "PRESENCE_UPDATE":
			if (!_data.guild_id) break;

			serverID = _data.guild_id;
			userID = _data.user.id;

			if (!client.users[userID]) client.users[userID] = new User(_data.user);

			user = client.users[userID];
			member = client.servers[serverID].members[userID] || {};

			copyKeys(_data.user, user);
			user.game = _data.game;

			copyKeys(_data, member, ['user', 'guild_id', 'game']);
			client.emit('presence', user.username, user.id, member.status, user.game, message);
			break;
		case "USER_UPDATE":
			copyKeys(_data, client);
			break;
		case "USER_SETTINGS_UPDATE":
			copyKeys(_data, client.internals);
			break;
		case "GUILD_CREATE":
			/*The lib will attempt to create the server using the response from the
			REST API, if the user using the lib creates the server. There are missing keys, however.
			So we still need this GUILD_CREATE event to fill in the blanks.
			If It's not our created server, then there will be no server with that ID in the cache,
			So go ahead and create one.*/
			client.servers[_data.id] = new Server(client, _data);
			return emit(client, message, client.servers[_data.id]);
		case "GUILD_UPDATE":
			old = copy(client.servers[_data.id]);
			Server.update(client, _data);
			return emit(client, message, old, client.servers[_data.id]);
		case "GUILD_DELETE":
			emit(client, message, client.servers[_data.id]);
			return delete(client.servers[_data.id]);
		case "GUILD_MEMBER_ADD":
			client.users[_data.user.id] = new User(_data.user);
			client.servers[_data.guild_id].members[_data.user.id] = new Member(client, client.servers[_data.guild_id], _data);
			client.servers[_data.guild_id].member_count += 1;
			return emit(client, message, client.servers[_data.guild_id].members[_data.user.id]);
		case "GUILD_MEMBER_UPDATE":
			old = copy(client.servers[_data.guild_id].members[_data.user.id]);
			Member.update(client, client.servers[_data.guild_id], _data);
			return emit(client, message, old, client.servers[_data.guild_id].members[_data.user.id]);
		case "GUILD_MEMBER_REMOVE":
			if (_data.user && _data.user.id === client.id) return;
			client.servers[_data.guild_id].member_count -= 1;
			emit(client, message, client.servers[_data.guild_id].members[_data.user.id]);
			return delete(client.servers[_data.guild_id].members[_data.user.id]);
		case "GUILD_ROLE_CREATE":
			client.servers[_data.guild_id].roles[_data.role.id] = new Role(_data.role);
			return emit(client, message, client.servers[_data.guild_id].roles[_data.role.id]);
		case "GUILD_ROLE_UPDATE":
			server = client.servers[_data.guild_id];
			old = copy(server.roles[_data.role.id]);
			Role.update(server, _data);
			Object.keys(server.members).forEach(function(memberID) {
				var member = server.members[memberID];
				if ( member.roles.indexOf(_data.role.id) < 0 ) return;
				member.color = colorFromRole(server, member);
			});
			return emit(client, message, old, server.roles[_data.role.id]);
		case "GUILD_ROLE_DELETE":
			emit(client, message, client.servers[_data.guild_id].roles[_data.role_id]);
			return delete(client.servers[_data.guild_id].roles[_data.role_id]);
		case "CHANNEL_CREATE":
			channelID = _data.id;

			if (_data.is_private) {
				if (client.directMessages[channelID]) return;
				client.directMessages[channelID] = new DMChannel(client._uIDToDM, _data);
				return emit(client, message, client.directMessages[channelID]);
			}

			if (client.channels[channelID]) return;
			client.channels[channelID] = new Channel(client, client.servers[_data.guild_id], _data);
			return emit(client, message, client.channels[channelID]);
		case "CHANNEL_UPDATE":
			old = copy(client.channels[_data.id]);
			Channel.update(client, _data);
			return emit(client, message, old, client.channels[_data.id]);
		case "CHANNEL_DELETE":
			if (_data.is_private === true) {
				emit(client, message, client.directMessages[_data.id]);
				delete(client.directMessages[_data.id]);
				return delete(client._uIDToDM[_data.recipient.id]);
			}
			emit(client, message, client.servers[_data.guild_id].channels[_data.id]);
			delete(client.servers[_data.guild_id].channels[_data.id]);
			return delete(client.channels[_data.id]);
		case "GUILD_EMOJIS_UPDATE":
			old = copy(client.servers[_data.guild_id].emojis);
			Emoji.update(client.servers[_data.guild_id], _data.emojis);
			return emit(client, message, old, client.servers[_data.guild_id].emojis);
		case "VOICE_STATE_UPDATE":
			serverID = _data.guild_id;
			channelID = _data.channel_id;
			userID = _data.user_id;
			server = client.servers[serverID];

			try {
				currentVCID = server.members[userID].voice_channel_id;
				if (currentVCID) delete( server.channels[currentVCID].members[userID] );
				if (channelID) server.channels[channelID].members[userID] = _data;
				server.members[userID].voice_channel_id = channelID;
			} catch(e) {}

			if (userID === client.id) {
				if (channelID === null) {
					if (server.voiceSession) leaveVoiceChannel(client, server.voiceSession.channelID);
					return void(server.voiceSession = null);
				}
				if (!server.voiceSession) {
					server.voiceSession = getVoiceSession(client, channelID, server);
				}
				if (channelID !== server.voiceSession.channelID) {
					delete( client._vChannels[server.voiceSession.channelID] );
					getVoiceSession(client, channelID, server).channelID = channelID;
				}

				server.voiceSession.session = _data.session_id;
			}
			break;
		case "VOICE_SERVER_UPDATE":
			serverID = _data.guild_id;
			server = client.servers[serverID];
			server.voiceSession.token = _data.token;
			server.voiceSession.severID = serverID;
			server.voiceSession.endpoint = _data.endpoint;
			joinVoiceChannel(client, server.voiceSession);
			break;
		case "GUILD_MEMBERS_CHUNK":
			serverID = _data.guild_id;
			if (!client.servers[serverID].members) client.servers[serverID].members = {};

			_data.members.forEach(function(member) {
				var uID = member.user.id;
				var members = client.servers[serverID].members;
				if (members[uID]) return;
				if (!client.users[uID]) client.users[uID] = new User(member.user);
				members[uID] = new Member(client, client.servers[serverID], member);
			});
			var all = Object.keys(client.servers).every(function(server) {
				server = client.servers[server];
				return server.member_count === Object.keys(server.members).length;
			});

			if (all) return client.emit("allUsers");
			break;
		case "GUILD_SYNC":
			_data.members.forEach(function(member) {
				var uID = member.user.id;
				if (!client.users[uID]) client.users[uID] = new User(member.user);
				client.servers[_data.id].members[uID] = new Member(client, client.servers[_data.id], member);
			});

			_data.presences.forEach(function(presence) {
				var uID = presence.user.id;
				var members = client.servers[_data.id].members;
				if (!members[uID]) return void(new User(presence.user));
				delete(presence.user);
				copyKeys(presence, members[uID]);
			});
			client.servers[_data.id].large = _data.large;
			break;
	}
	return emit(client, message);
}
function handleWSClose(code, data) {
	var client = this;
	var eMsg = Discord.Codes.WebSocket[code];

	clearInterval(client._mainKeepAlive);
	client.connected = false;
	client.presenceStatus = "offline";
	removeAllListeners(client._ws, 'message');

	if ([1001, 1006].indexOf(code) > -1) return getGateway(client, client.internals.token);

	client._ready = false;
	client._ws = null;

	client.emit("disconnect", eMsg, code);
}

/* - Functions - Voice - */
function joinVoiceChannel(client, voiceSession) {
	var vWS, vUDP, endpoint = voiceSession.endpoint.split(":")[0];
	//handleVoiceChannelChange(client, voiceSession);

	voiceSession.ws = {};
	voiceSession.udp = {};
	voiceSession.members = {};
	voiceSession.error = null;
	voiceSession.ready = false;
	voiceSession.joined = false;
	voiceSession.translator = {};
	voiceSession.wsKeepAlive = null;
	voiceSession.udpKeepAlive = null;
	voiceSession.keepAlivePackets = 0;
	voiceSession.emitter = new Emitter();
	if (isNode) voiceSession.keepAliveBuffer = new Buffer(8).fill(0);
	vWS = voiceSession.ws.connection = new Websocket("wss://" + endpoint);

	if (isNode) return DNS.lookup(endpoint, function(err, address) {
		if (err) return void(voiceSession.error = err);

		voiceSession.address = address;
		vUDP = voiceSession.udp.connection = UDP.createSocket("udp4");

		vUDP.bind({exclusive: true});
		vUDP.once('message', handleUDPMessage.bind(client, voiceSession));

		vWS.once('open',  handlevWSOpen.bind(client, voiceSession));
		vWS.on('message', handlevWSMessage.bind(client, voiceSession));
		vWS.once('close', handlevWSClose.bind(client, voiceSession));
	});

	vWS.once('open',  handlevWSOpen.bind(client, voiceSession));
	vWS.on('message', handlevWSMessage.bind(client, voiceSession));
	vWS.once('close', handlevWSClose.bind(client, voiceSession));
	return void(voiceSession.joined = true);
}

function leaveVoiceChannel(client, channelID, callback) {
	if (!client._vChannels[channelID]) return;

	try {
		client._vChannels[channelID].ws.connection.close();
		client._vChannels[channelID].udp.connection.close();
	} catch(e) {}

	ws_send(client._ws, Payloads.UPDATE_VOICE(client.channels[channelID].guild_id, null));

	return call(callback, [null]);
}

function keepUDPAlive(VS) {
	if (!VS.keepAliveBuffer) return;

	if (VS.keepAlivePackets > 4294967294) {
		VS.keepAlivePackets = 0;
		VS.keepAliveBuffer.fill(0);
	}
	VS.keepAliveBuffer.writeUIntLE(++VS.keepAlivePackets, 0, 6);
	try {
		return VS.udp.connection.send(VS.keepAliveBuffer, 0, VS.keepAliveBuffer.length, VS.ws.port, VS.address);
	} catch(e) {}
}

function getVoiceSession(client, channelID, server) {
	if (!channelID) return null;
	return client._vChannels[channelID] ?
		client._vChannels[channelID] :
		client._vChannels[channelID] = (server && server.voiceSession) || {
			serverID: (server && server.id) || null,
			channelID: channelID,
			token: null,
			session: null,
			endpoint: null
		};
}

function checkVoiceReady(voiceSession, callback) {
	return setTimeout(function() {
		if (voiceSession.error) return call(callback, [error]);
		if (voiceSession.joined) return call(callback, [null, voiceSession.emitter]);
		return checkVoiceReady(voiceSession, callback);
	}, 1);
}

/* - Functions - Voice - Handling - */

function handlevWSOpen(voiceSession) {
	return ws_send(voiceSession.ws.connection, Payloads.VOICE_IDENTIFY(this.id, voiceSession));
}
function handlevWSMessage(voiceSession, vMessage, vFlags) {
	var client = this, vData = decompressWSMessage(vMessage, vFlags);
	switch (vData.op) {
		case 2: //Ready (Actually means you're READY to initiate the UDP connection)
			copyKeys(vData.d, voiceSession.ws);
			voiceSession.wsKeepAlive = setInterval(send, vData.d.heartbeat_interval, voiceSession.ws.connection, { "op": 3, "d": null });

			if (!isNode) return;

			var udpDiscPacket = new Buffer(70);
			udpDiscPacket.writeUIntBE(vData.d.ssrc, 0, 4);
			voiceSession.udp.connection.send(
				udpDiscPacket, 0, udpDiscPacket.length, vData.d.port, voiceSession.address,
				function(err) { if (err) {leaveVoiceChannel(client, voiceSession.channelID); handleErrCB("UDP discovery error", callback); } }
			);

			voiceSession.udpKeepAlive = setInterval(keepUDPAlive, 5000, voiceSession);
			break;
		case 4: //Session Discription (Actually means you're ready to send audio... stupid Discord Devs :I)
			voiceSession.selectedMode = vData.d.mode;
			voiceSession.secretKey = vData.d.secret_key;
			voiceSession.joined = true;
			voiceSession.ready = true;
			break;
		case 5: //Speaking (At least this isn't confusing!)
			voiceSession.emitter.emit('speaking', vData.d.user_id, vData.d.ssrc, vData.d.speaking);
			break;
	}
}
function handlevWSClose(voiceSession) {
	//Emit the disconnect event first
	voiceSession.emitter.emit("disconnect", voiceSession.channelID);
	voiceSession.emitter = null
	//Kill encoder and decoders
	var audio = voiceSession.audio, members = voiceSession.members;
	if (audio) {
		if (audio._systemEncoder) audio._systemEncoder.kill();
		if (audio._mixedDecoder) audio._mixedDecoder.destroy();
	}

	Object.keys(members).forEach(function(ID) {
		var member = members[ID];
		if (member.decoder) member.decoder.destroy();
	});

	//Clear intervals and remove listeners
	clearInterval(voiceSession.wsKeepAlive);
	clearInterval(voiceSession.udpKeepAlive);
	removeAllListeners(voiceSession.emitter);
	removeAllListeners(voiceSession.udp.connection, 'message');
	removeAllListeners(voiceSession.ws.connection, 'message');

	return delete(this._vChannels[voiceSession.channelID]);
}

function handleUDPMessage(voiceSession, msg, rinfo) {
	var buffArr = JSON.parse(JSON.stringify(msg)).data, client = this, vDiscIP = "", vDiscPort;
	for (var i=4; i<buffArr.indexOf(0, i); i++) {
		vDiscIP += String.fromCharCode(buffArr[i]);
	}
	vDiscPort = msg.readUIntLE(msg.length - 2, 2).toString(10);
	return ws_send(voiceSession.ws.connection, Payloads.VOICE_DISCOVERY(vDiscIP, vDiscPort, 'xsalsa20_poly1305'));
}

/* - Functions - Voice - AudioCallback - */
function AudioCB(voiceSession, audioChannels, encoder, maxStreamSize) {
	//With the addition of the new Stream API, `playAudioFile`, `stopAudioFile` and `send`
	//will be removed. However they're deprecated for now, hence the code repetition.
	if (maxStreamSize && !Opus) Opus = require('cjopus');
	Stream.Duplex.call(this);
	var ACBI = this;

	this.audioChannels = audioChannels;
	this.members = voiceSession.members;

	applyProperties(this, [
		["_sequence", 0],
		["_timestamp", 0],
		["_readable", false],
		["_streamRef", null],
		["_startTime", null],
		["_systemEncoder", null],
		["_playingAudioFile", false],
		["_voiceSession", voiceSession],
		["_port", voiceSession.ws.port],
		["_address", voiceSession.address],
		["_decodeNonce", new Uint8Array(24)],
		["_vUDP", voiceSession.udp.connection],
		["_secretKey", new Uint8Array(voiceSession.secretKey)],
		["_mixedDecoder", Opus && new Opus.OpusEncoder( 48000, audioChannels ) || null]
	]);
	
	createAudioEncoder(this, encoder);

	this._write = function _write(chunk, encoding, callback) {
		ACBI._systemEncoder.stdin.write(chunk);
		return callback();
	};
	this._read = function _read() {};
	this.stop = function stop() {
		return this._systemEncoder.stdout.read = function() { return null };
	};

	if (maxStreamSize) {
		voiceSession.ws.connection.on('message', function(data, flags) {
			data = decompressWSMessage(data, flags);

			if (data.op !== 5) return;
			if (!voiceSession.members[data.d.user_id]) {
				voiceSession.members[data.d.user_id] = new Stream.Readable({
					highWaterMark: maxStreamSize,
					read: function(s) {}
				});
				voiceSession.members[data.d.user_id].decoder = new Opus.OpusEncoder( 48000, ACBI.audioChannels );
				ACBI.emit('newMemberStream', data.d.user_id, voiceSession.members[data.d.user_id]);
			}

			voiceSession.members[data.d.user_id].ssrc = data.d.ssrc;
			voiceSession.translator[data.d.ssrc] = voiceSession.members[data.d.user_id];
		});
		this._vUDP.on('message', handleIncomingAudio.bind(this));
	}
}
if (isNode) Util.inherits(AudioCB, Stream.Duplex);
AudioCB.VoicePacket = (function() {
	if (!isNode) return;
	var header = new Buffer(12), nonce = new Uint8Array(24), output = new Buffer(2048);

	header[0] = 0x80;
	header[1] = 0x78;

	return function(packet, ssrc, sequence, timestamp, key) {
		header.writeUIntBE(sequence, 2, 2);
		header.writeUIntBE(timestamp, 4, 4);
		header.writeUIntBE(ssrc, 8, 4);
		//<Buffer 80 78 00 01 00 00 03 c0 00 00 00 01>
		nonce.set(header);
		//<Buffer 80 78 00 01 00 00 03 c0 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00>

		var encrypted = new Buffer(
			NACL.secretbox(
				new Uint8Array(packet),
				nonce,
				key
			)
		);

		header.copy(output);
		encrypted.copy(output, 12);

		return output.slice(0, header.length + encrypted.length);
	};
})();

function prepareAudio(ACBI, readableStream, cnt) {
	var data = readableStream.read( 320 ) || readableStream.read(); //(128 [kb] * 20 [frame_size]) / 8 == 320

	if (!data) {
		ws_send(ACBI._voiceSession.ws.connection, Payloads.VOICE_SPEAK(0));
		ACBI._readable = false;
		return readableStream.emit('end');
	}

	return setTimeout(function() {
		sendAudio(ACBI, data);
		prepareAudio(ACBI, readableStream, cnt + 1);
	}, 20 + ( (ACBI._startTime + cnt * 20) - Date.now() ));
}

function sendAudio(ACBI, buffer) {
	ACBI._sequence  = (ACBI._sequence  + 1  ) < 0xFFFF     ? ACBI._sequence  + 1   : 0;
	ACBI._timestamp = (ACBI._timestamp + 960) < 0xFFFFFFFF ? ACBI._timestamp + 960 : 0;
	var audioPacket = AudioCB.VoicePacket(buffer, ACBI._voiceSession.ws.ssrc, ACBI._sequence, ACBI._timestamp, ACBI._secretKey);

	try {
		//It throws a synchronous error if it fails (someone leaves the audio channel while playing audio)
		ACBI._vUDP.send(audioPacket, 0, audioPacket.length, ACBI._port, ACBI._address);
	} catch(e) { return; }
}

function handleIncomingAudio(msg) {
	//The response from the UDP keep alive ping
	if (msg.length === 8) return;

	var header = msg.slice(0, 12),
		audio = msg.slice(12),
		ssrc = header.readUIntBE(8, 4),
		member = this._voiceSession.translator[ssrc],
		decrypted, decoded;

		this._decodeNonce.set(header);

		try {
			decrypted = new Buffer(
				NACL.secretbox.open(
					new Uint8Array(audio),
					this._decodeNonce,
					this._secretKey
				)
			);

			if (member) {
				decoded = member.decoder.decode(decrypted);
				addToStreamBuffer(member, decoded);
			} else {
				decoded = this._mixedDecoder.decode(decrypted);
			}

			addToStreamBuffer(this, decoded);
			this.emit('incoming', ssrc, decoded );
		} catch(e) {}
}
function addToStreamBuffer(RStream, data) {
	return RStream.push(new Buffer(data)) || !!RStream.read(data.length);
}

function chooseAudioEncoder(players) {
	if (!players[0]) return null;
	var s = ChildProc.spawnSync(players.shift());
	return s.error ? chooseAudioEncoder(players) : s.file;
}
function createAudioEncoder(ACBI, encoder) {
	var enc = ACBI._systemEncoder;
	if (enc) {
		enc.stdout.emit('end');
		enc.kill();
		ACBI._systemEncoder = null;
	}

	enc = ACBI._systemEncoder = ChildProc.spawn(encoder, [
		'-hide_banner',
		'-loglevel', 'error',
		'-i', 'pipe:0',
		'-map', '0:a',
		'-acodec', 'libopus',
		'-f', 'data',
		'-sample_fmt', 's16',
		'-vbr', 'off',
		'-compression_level', '10',
		'-ar', '48000',
		'-ac', ACBI.audioChannels,
		'-b:a', '128000',
		'pipe:1'
	], {stdio: ['pipe', 'pipe', 'pipe']});

	enc.stderr.once('data', function(d) {
		if (ACBI.listeners('error').length > 0) ACBI.emit('error', d.toString());
	});

	enc.stdin.once('error', function(e) {
		enc.stdout.emit('end');
		enc.kill();
	});

	enc.stdout.once('error', function(e) {
		enc.stdout.emit('end');
		enc.kill();
	});
	enc.stdout.once('end', function() {
		createAudioEncoder(ACBI, encoder);
		ACBI.emit('done');
	});
	enc.stdout.on('readable', function() {
		if (ACBI._readable) return;

		ACBI._readable = true;
		ws_send(ACBI._voiceSession.ws.connection, Payloads.VOICE_SPEAK(1));
		ACBI._startTime = new Date().getTime();
		prepareAudio(ACBI, enc.stdout, 1);
	});
}

/* - DiscordClient - Classes - */
function Resource() {}
Object.defineProperty(Resource.prototype, "creationTime", {
	get: function() { return (+this.id / 4194304) + 1420070400000; },
	set: function() {}
});
[Server, Channel, DMChannel, User, Member, Role].forEach(function(p) {
	p.prototype = Object.create(Resource.prototype);
	Object.defineProperty(p.prototype, 'constructor', {value: p, enumerable: false});
});

function Server(client, data) {
	var server = this;
	//Accept everything now and trim what we don't need, manually. Any data left in is fine, any data left out could lead to a broken lib.
	copyKeys(data, this);
	this.large = this.large || this.member_count > LARGE_THRESHOLD;
	this.voiceSession = null;
	if (data.unavailable) return;

	//Objects so we can use direct property accessing without for loops
	this.channels = {};
	this.members = {};
	this.roles = {};
	this.emojis = {};

	//Copy the data into the objects using IDs as keys
	data.channels.forEach(function(channel) {
		client.channels[channel.id] = new Channel(client, server, channel);
	});
	data.roles.forEach(function(role) {
		server.roles[role.id] = new Role(role);
	});
	data.members.forEach(function(member) {
		client.users[member.user.id] = new User(member.user);
		server.members[member.user.id] = new Member(client, server, member);
	});
	data.presences.forEach(function(presence) {
		var id = presence.user.id;
		if (!client.users[id] || !server.members[id]) return;
		delete(presence.user);

		client.users[id].game = presence.game;
		server.members[id].status = presence.status;
	});
	data.emojis.forEach(function(emoji) {
		server.emojis[emoji.id] = new Emoji(emoji);
	});
	data.voice_states.forEach(function(vs) {
		var cID = vs.channel_id;
		var uID = vs.user_id;
		if (!server.channels[cID] || !server.members[uID]) return;
		server.channels[cID].members[uID] = vs;
		server.members[uID].voice_channel_id = cID;
	});

	//Now we can get rid of any of the things we don't need anymore
	delete(this.voice_states);
	delete(this.presences);
}
function Channel(client, server, data) {
	var channel = this;
	this.members = {};
	this.permissions = { user: {}, role: {} };
	this.guild_id = server.id;
	copyKeys(data, this, ['permission_overwrites', 'emojis']);
	Object.defineProperty(server.channels, channel.id, {
		get: function() { return client.channels[channel.id]; },
		set: function(v) { client.channels[channel.id] = v; },
		enumerable: true,
		configurable: true
	});
	data.permission_overwrites.forEach(function(p) {
		var type = (p.type === 'member' ? 'user' : 'role');
		this.permissions[type][p.id] = {allow: p.allow, deny: p.deny};
	}, this);


	delete(this.is_private);
}
function DMChannel(client, translator, data) {
	//copyKeys(data, this);
	//translator[data.recipient.id] = data.id;
	delete(this.is_private);
}
function User(data) {
	copyKeys(data, this);
	this.bot = this.bot || false;
}
function Member(client, server, data) {
	copyKeys(data, this, ['user', 'joined_at',]);
	this.id = data.user.id;
	this.joined_at = Date.parse(data.joined_at);
	this.color = colorFromRole(server, this);
	['username', 'discriminator', 'bot', 'avatar', 'game'].forEach(function(k) {
		if (k in Member.prototype) return;

		Object.defineProperty(Member.prototype, k, {
			get: function() { return client.users[this.id][k]; },
			set: function(v) { client.users[this.id][k] = v; },
			enumerable: true,
		});
	});
}
function Role(data) {
	copyKeys(data, this, ['permissions']);
	//Use `permissions` from Discord, or `_permissions` if we're making it out of a cache.
	this._permissions = data._permissions || data.permissions;
}
function Emoji(data) {
	copyKeys(data, this);
}

function Multipart() {
	this.boundary =
		"NodeDiscordIO" + "-" + CURRENT_VERSION;
	this.result = "";
}
Multipart.prototype.append = function(data) {
	/* Header */
	var str = "\r\n--";
	str += this.boundary + "\r\n";
	str += 'Content-Disposition: form-data; name="' + data[0] + '"';
	if (data[2]) {
		str += '; filename="' + data[2] + '"\r\n';
		str += 'Content-Type: application/octet-stream';
	}
	/* Body */
	str += "\r\n\r\n" + ( data[1] instanceof Buffer ? data[1] : new Buffer(String(data[1]), 'utf-8') ).toString('binary');
	this.result += str;
};
Multipart.prototype.finalize = function() {
	this.result += "\r\n--" + this.boundary + "--";
};

Server.update = function(client, data) {
	if (!client.servers[data.id]) client.servers[data.id] = {}; // new Server(client, data)?
	for (var key in data) {
		if (key === 'roles') {
			data[key].forEach(function(r) {
				client.servers[data.id].roles[r.id] = new Role(r);
			});
			continue;
		}
		if (key === 'emojis') continue;
		client.servers[data.id][key] = data[key];
	}
};
Channel.update = function(client, data) {
	if (!client.channels[data.id]) client.channels[data.id] = {}; // new Channel(client, data)?
	for (var key in data) {
		if (key === 'permission_overwrites') {
			data[key].forEach(function(p) {
				var type = (p.type === 'member' ? 'user' : 'role');
				client.channels[data.id].permissions[type][p.id] = {
					allow: p.allow,
					deny: p.deny
				};
			});
			continue;
		}
		client.channels[data.id][key] = data[key];
	}
	delete(client.channels[data.id].is_private);
};
Member.update = function(client, server, data) {
	if (!server.members[data.user.id]) return server.members[data.user.id] = new Member(client, server, data);
	var member = server.members[data.user.id];
	copyKeys(data, member, ['user']);
	member.color = colorFromRole(server, member);
};
Role.update = function(server, data) {
	if (!server.roles[data.role.id]) server.roles[data.role.id] = {}; // new Role(data)?
	server.roles[data.role.id]._permissions = data.role.permissions;
	copyKeys(data.role, server.roles[data.role.id], ['permissions']);
};
Emoji.update = function(server, data) {
	server.emojis = {};
	data.forEach(function(emoji) {
		server.emojis[emoji.id] = new Emoji(emoji);
	});
}

Object.defineProperty(User.prototype, 'avatarURL', {
	get: function() { 
		if (!this.avatar) return null;
		var animated = this.avatar.indexOf("a_") > -1;
		return Discord.Endpoints.CDN + "/avatars/" + this.id + "/" + this.avatar + (animated ? ".gif" : ".webp");
	},
	set: function() {}
});


Discord.version = CURRENT_VERSION;
Discord.Client = DiscordClient;
Discord.Codes = {};
Discord.Codes.WebSocket = {
	"0"   : "Gateway Error",
	"4000": "Unknown Error (Try reconnecting)",
	"4001": "Unknown Opcode",
	"4002": "Decode Error",
	"4003": "Not Authenticated",
	"4004": "Authentication Failed (Incorrect token)",
	"4005": "Already Authenticated (Identity sent twice)",
	"4006": "Session Not Valid",
	"4007": "Invalid Sequence Number (Resume error, re-create client)",
	"4008": "Rate Limited",
	"4009": "Session Timeout (Reconnect)",
	"4010": "Invalid Shard (Double-check your shard configuration)",
	"4011": "Sharding Required (Too many guilds on one shard)"
};
Discord.Channel = {
	Text: 0,
	Private: 1,
	Voice: 2,
	Group: 3
}
Discord.Message = {
	Default: 0,
	GroupRecipientAdd: 1,
	GroupRecipientRemove: 2,
	GroupCallCreate: 3,
	GroupNameUpdate: 4,
	GroupIconUpdate: 5,
	PinAdd: 6
};
Discord.Status = {
	Invisible: 'invisible',
	Online: 'online',
	Idle: 'idle',
	DND: 'dnd'
};
Discord.Stream = {
	Twitch: 1
};
Discord.URL = {
	Twitch: function Twitch(name) {
		return `https://www.twitch.tv/${name}`;
	}
};
Discord.Colors = {
	DEFAULT: 0,
	AQUA: 1752220,
	GREEN: 3066993,
	BLUE: 3447003,
	PURPLE: 10181046,
	GOLD: 15844367,
	ORANGE: 15105570,
	RED: 15158332,
	GREY: 9807270,
	DARKER_GREY: 8359053,
	NAVY: 3426654,
	DARK_AQUA: 1146986,
	DARK_GREEN: 2067276,
	DARK_BLUE: 2123412,
	DARK_PURPLE: 7419530,
	DARK_GOLD: 12745742,
	DARK_ORANGE: 11027200,
	DARK_RED: 10038562,
	DARK_GREY: 9936031,
	LIGHT_GREY: 12370112,
	DARK_NAVY: 2899536
};
Discord.Permissions = {
	GENERAL_CREATE_INSTANT_INVITE: 0,
	GENERAL_KICK_MEMBERS: 1,
	GENERAL_BAN_MEMBERS: 2,
	GENERAL_ADMINISTRATOR: 3,
	GENERAL_MANAGE_CHANNELS: 4,
	GENERAL_MANAGE_GUILD: 5,
	GENERAL_MANAGE_ROLES: 28,
	GENERAL_MANAGE_NICKNAMES: 27,
	GENERAL_CHANGE_NICKNAME: 26,
	GENERAL_MANAGE_WEBHOOKS: 29,
	GENERAL_MANAGE_EMOJIS: 30,

	TEXT_ADD_REACTIONS: 6,
	TEXT_READ_MESSAGES: 10,
	TEXT_SEND_MESSAGES: 11,
	TEXT_SEND_TTS_MESSAGE: 12,
	TEXT_MANAGE_MESSAGES: 13,
	TEXT_EMBED_LINKS: 14,
	TEXT_ATTACH_FILES: 15,
	TEXT_READ_MESSAGE_HISTORY: 16,
	TEXT_MENTION_EVERYONE: 17,
	TEXT_EXTERNAL_EMOJIS: 18,

	VOICE_CONNECT: 20,
	VOICE_SPEAK: 21,
	VOICE_MUTE_MEMBERS: 22,
	VOICE_DEAFEN_MEMBERS: 23,
	VOICE_MOVE_MEMBERS: 24,
	VOICE_USE_VAD: 25,
};

Object.keys(Discord.Permissions).forEach(function(pn) {
	Object.defineProperty(Role.prototype, pn, {
		get: getPerm( Discord.Permissions[pn] ),
		set: setPerm( Discord.Permissions[pn] ),
		enumerable: true
	});
});

/* Wrappers */
function Emitter() {
	var emt = this;
	if (isNode) {
		EE.call(this);
		if (this.prototype) return Util.inherits(this, EE);
		return new EE();
	}
	//Thank you, http://stackoverflow.com/a/24216547
	function _Emitter() {
		var eventTarget = document.createDocumentFragment();
		["addEventListener", "dispatchEvent", "removeEventListener"].forEach(function(method) {
			if (!this[method]) this[method] = eventTarget[method].bind(eventTarget);
		}, this);
	}
	//But I did the rest myself! D:<
	_Emitter.call(this);
	this._evts = {};
	this.on = function(eName, eFunc) {
		if (!emt._evts[eName]) emt._evts[eName] = [];
		emt._evts[eName].push(eOn);

		return this.addEventListener(eName, eOn);

		function eOn(e) {
			return eFunc.apply(null, resolveEvent(e));
		}
	};
	this.once = function(eName, eFunc) {
		if (!emt._evts[eName]) emt._evts[eName] = [];
		emt._evts[eName].push(eOnce);

		return this.addEventListener(eName, eOnce);

		function eOnce(e) {
			eFunc.apply(null, resolveEvent(e));
			return emt.removeListener(eName, eOnce);
		}
	};
	this.removeListener = function(eName, eFunc) {
		if (emt._evts[eName]) emt._evts[eName].splice(emt._evts[eName].lastIndexOf(eFunc), 1);
		return this.removeEventListener(eName, eFunc);
	};
	this.emit = function(eName) {
		return this.dispatchEvent( new CustomEvent(eName, {'detail': Array.prototype.slice.call(arguments, 1) }) );
	};
	return this;
}

function Websocket(url, opts) {
	if (isNode) return new (require('ws'))(url, opts);
	return Emitter.call(new WebSocket(url));
}

/* Endpoints */
(function () {
	var API = "https://discordapp.com/api";
	var CDN = "http://cdn.discordapp.com";
	var ME  = API + "/users/@me";
	Endpoints = Discord.Endpoints = {
		API: 		API,
		CDN: 		CDN,

		ME:			ME,
		NOTE:		function(userID) {
			return  ME + "/notes/" + userID;
		},
		LOGIN:		API + "/auth/login",
		OAUTH:		API + "/oauth2/applications/@me",
		GATEWAY:	API + "/gateway",
		SETTINGS: 	ME + "/settings",

		SERVERS: function(serverID) {
			return  API + "/guilds" + (serverID ? "/" + serverID : "");
		},
		SERVERS_PERSONAL: function(serverID) {
			return  this.ME + "/guilds" + (serverID ? "/" + serverID : ""); //Method to list personal servers?
		},
		SERVER_EMOJIS: function(serverID, emojiID) {
			return  this.SERVERS(serverID) + "/emojis" + (emojiID ? "/" + emojiID : "");
		},

		CHANNEL: function(channelID) {
			return  API + "/channels/" + channelID;
		},

		MEMBERS: function(serverID, userID) {
			return  this.SERVERS(serverID) + "/members" + (userID ? "/" + userID : "");
		},
		MEMBER_ROLES: function(serverID, userID, roleID) {
			return	this.MEMBERS(serverID, userID) + "/roles" + (roleID ? "/" + roleID : "");
		},

		USER: function(userID) {
			return  API + "/users/" + userID;
		},

		ROLES: function(serverID, roleID) {
			return  this.SERVERS(serverID) + "/roles" + (roleID ? "/" + roleID : "");
		},

		BANS: function(serverID, userID) {
			return  this.SERVERS(serverID) + "/bans" + (userID ? "/" + userID : "");
		},

		MESSAGES: function(channelID, messageID) {
			return  this.CHANNEL(channelID) + "/messages" + (messageID ? "/" + messageID : "");
		},
		PINNED_MESSAGES: function(channelID, messageID) {
			return  this.CHANNEL(channelID) + "/pins" + (messageID ? "/" + messageID : "");
		},

		MESSAGE_REACTIONS: function(channelID, messageID, reaction) {
			return  this.MESSAGES(channelID, messageID) + "/reactions" + ( reaction ? ("/" + reaction) : "" );
		},
		USER_REACTIONS: function(channelID, messageID, reaction, userID) {
		  	return  this.MESSAGE_REACTIONS(channelID, messageID, reaction) + '/' + ( (!userID || userID === this.id) ? '@me' : userID );
		},

		INVITES: function(inviteCode) {
			return  API + "/invite/" + inviteCode;
		},

		SERVER_WEBHOOKS: function(serverID) {
			return  this.SERVERS(serverID) + "/webhooks";
		},
		CHANNEL_WEBHOOKS: function(channelID) {
			return  this.CHANNEL(channelID) +"/webhooks";
		},

		WEBHOOKS: function(webhookID) {
			return  API + "/webhooks/" + webhookID;
		},

		BULK_DELETE: function(channelID) {
			return  this.CHANNEL(channelID) + "/messages/bulk-delete";
		},

		TYPING: function(channelID) {
			return  this.CHANNEL(channelID) + "/typing";
		}

	};
})();

/* Payloads */
(function() {
	Payloads = {
		IDENTIFY: function(client) {
			return {
				op: 2,
				d: {
					token: client.internals.token,
					v: GATEWAY_VERSION,
					compress: isNode && !!Zlib.inflateSync,
					large_threshold: LARGE_THRESHOLD,
					properties: {
						$os: isNode ? require('os').platform() : navigator.platform,
						$browser:"discord.io",
						$device:"discord.io",
						$referrer:"",
						$referring_domain:""
					}
				}
			};
		},
		RESUME: function(client) {
			return {
				op: 6,
				d: {
					seq: client.internals.s,
					token: client.internals.token,
					session_id: client.internals.sessionID
				}
			};
		},
		HEARTBEAT: function(client) {
			return {op: 1, d: client.internals.sequence};
		},
		ALL_USERS: function(client) {
			return {op: 12, d: Object.keys(client.servers)};
		},
		STATUS: function(status_string, game_object) {
			return {
				op: 3,
				d: {
					status: status_string,
					game: game_object
				},
				afk: false,
				since: 0
			}
		},
		STATUS: function(client, input) {
			return {
				op: 3,
				d: {
					status: input.status || client.status,
					game: type(input.game) === 'object' ?
						{
							name: input.game.name ? String(input.game.name) : null,
							type: input.game.type ? Number(input.game.type) : null,
							url: input.game.url ? String(input.game.url) : null
						} :
						null,
					afk: false,
					since: 0
				}
			}
		},
		UPDATE_VOICE: function(serverID, channelID) {
			return {
				op: 4,
				d: {
					guild_id: serverID,
					channel_id: channelID,
					self_mute: false,
					self_deaf: false
				}
			};
		},
		OFFLINE_USERS: function(array) {
			return {
				op: 8,
				d: {
					guild_id: array.splice(0, 50),
					query: "",
					limit: 0
				}
			};
		},
		VOICE_SPEAK: function(v) {
			return {op:5, d:{ speaking: !!v, delay: 0 }};
		},
		VOICE_IDENTIFY: function(clientID, voiceSession) {
			return {
				op: 0,
				d: {
					server_id: voiceSession.serverID,
					user_id: clientID,
					session_id: voiceSession.session,
					token: voiceSession.token
				}
			};
		},
		VOICE_DISCOVERY: function(ip, port, mode) {
			return {
				op:1,
				d:{
					protocol:"udp",
					data:{
						address: ip,
						port: Number(port),
						mode: mode
					}
				}
			};
		}
	}
})();

})(typeof exports === 'undefined'? this.Discord = {} : exports);
