// answer.js
// Answer model logic.

var neo4j = require('neo4j');
var errors = require('./errors');

var db = new neo4j.GraphDatabase({
    // Support specifying database info via environment variables,
    // but assume Neo4j installation defaults.
    url: process.env['NEO4J_URL'] || process.env['GRAPHENEDB_URL'] ||
        'http://neo4j:neo4j@localhost:7474',
    auth: process.env['NEO4J_AUTH'],
});

// Private constructor:

var Answer = module.exports = function Answer(_node) {
    // All we'll really store is the node; the rest of our properties will be
    // derivable or just pass-through properties (see below).
    this._node = _node;
}

// Public constants:

Answer.VALIDATION_INFO = {
    'answername': {
        required: true,
        minLength: 2,
        maxLength: 16,
        pattern: /^[A-Za-z0-9_]+$/,
        message: '2-16 characters; letters, numbers, and underscores only.'
    },
};

// Public instance properties:

// The answer's answername, e.g. 'aseemk'.
Object.defineProperty(Answer.prototype, 'answername', {
    get: function () { return this._node.properties['answername']; }
});

// Private helpers:

// Takes the given caller-provided properties, selects only known ones,
// validates them, and returns the known subset.
// By default, only validates properties that are present.
// (This allows `Answer.prototype.patch` to not require any.)
// You can pass `true` for `required` to validate that all required properties
// are present too. (Useful for `Answer.create`.)
function validate(props, required) {
    var safeProps = {};

    for (var prop in Answer.VALIDATION_INFO) {
        var val = props[prop];
        validateProp(prop, val, required);
        safeProps[prop] = val;
    }

    return safeProps;
}

// Validates the given property based on the validation info above.
// By default, ignores null/undefined/empty values, but you can pass `true` for
// the `required` param to enforce that any required properties are present.
function validateProp(prop, val, required) {
    var info = Answer.VALIDATION_INFO[prop];
    var message = info.message;

    if (!val) {
        if (info.required && required) {
            throw new errors.ValidationError(
                'Missing ' + prop + ' (required).');
        } else {
            return;
        }
    }

    if (info.minLength && val.length < info.minLength) {
        throw new errors.ValidationError(
            'Invalid ' + prop + ' (too short). Requirements: ' + message);
    }

    if (info.maxLength && val.length > info.maxLength) {
        throw new errors.ValidationError(
            'Invalid ' + prop + ' (too long). Requirements: ' + message);
    }

    if (info.pattern && !info.pattern.test(val)) {
        throw new errors.ValidationError(
            'Invalid ' + prop + ' (format). Requirements: ' + message);
    }
}

function isConstraintViolation(err) {
    return err instanceof neo4j.ClientError &&
        err.neo4j.code === 'Neo.ClientError.Schema.ConstraintViolation';
}

// Public instance methods:

// Atomically updates this answer, both locally and remotely in the db, with the
// given property updates.
Answer.prototype.patch = function (props, callback) {
    var safeProps = validate(props);

    var query = [
        'MATCH (answer:Answer {answername: {answername}})',
        'SET answer += {props}',
        'RETURN answer',
    ].join('\n');

    var params = {
        answername: this.answername,
        props: safeProps,
    };

    var self = this;

    db.cypher({
        query: query,
        params: params,
    }, function (err, results) {
        if (isConstraintViolation(err)) {
            // TODO: This assumes answername is the only relevant constraint.
            // We could parse the constraint property out of the error message,
            // but it'd be nicer if Neo4j returned this data semantically.
            // Alternately, we could tweak our query to explicitly check first
            // whether the answername is taken or not.
            err = new errors.ValidationError(
                'The answername ‘' + props.answername + '’ is taken.');
        }
        if (err) return callback(err);

        if (!results.length) {
            err = new Error('Answer has been deleted! Answername: ' + self.answername);
            return callback(err);
        }

        // Update our node with this updated+latest data from the server:
        self._node = results[0]['answer'];

        callback(null);
    });
};

Answer.prototype.del = function (callback) {
    // Use a Cypher query to delete both this answer and his/her following
    // relationships in one query and one network request:
    // (Note that this'll still fail if there are any relationships attached
    // of any other types, which is good because we don't expect any.)
    var query = [
        'MATCH (answer:Answer {answername: {answername}})',
        'OPTIONAL MATCH (answer) -[rel:follows]- (other)',
        'DELETE answer, rel',
    ].join('\n')

    var params = {
        answername: this.answername,
    };

    db.cypher({
        query: query,
        params: params,
    }, function (err) {
        callback(err);
    });
};

Answer.prototype.follow = function (other, callback) {
    var query = [
        'MATCH (answer:Answer {answername: {thisAnswername}})',
        'MATCH (other:Answer {answername: {otherAnswername}})',
        'MERGE (answer) -[rel:follows]-> (other)',
    ].join('\n')

    var params = {
        thisAnswername: this.answername,
        otherAnswername: other.answername,
    };

    db.cypher({
        query: query,
        params: params,
    }, function (err) {
        callback(err);
    });
};

Answer.prototype.unfollow = function (other, callback) {
    var query = [
        'MATCH (answer:Answer {answername: {thisAnswername}})',
        'MATCH (other:Answer {answername: {otherAnswername}})',
        'MATCH (answer) -[rel:follows]-> (other)',
        'DELETE rel',
    ].join('\n')

    var params = {
        thisAnswername: this.answername,
        otherAnswername: other.answername,
    };

    db.cypher({
        query: query,
        params: params,
    }, function (err) {
        callback(err);
    });
};

// Calls callback w/ (err, following, others), where following is an array of
// answers this answer follows, and others is all other answers minus him/herself.
Answer.prototype.getFollowingAndOthers = function (callback) {
    // Query all answers and whether we follow each one or not:
    var query = [
        'MATCH (answer:Answer {answername: {thisAnswername}})',
        'MATCH (other:Answer)',
        'OPTIONAL MATCH (answer) -[rel:follows]-> (other)',
        'RETURN other, COUNT(rel)', // COUNT(rel) is a hack for 1 or 0
    ].join('\n')

    var params = {
        thisAnswername: this.answername,
    };

    var answer = this;
    db.cypher({
        query: query,
        params: params,
    }, function (err, results) {
        if (err) return callback(err);

        var following = [];
        var others = [];

        for (var i = 0; i < results.length; i++) {
            var other = new Answer(results[i]['other']);
            var follows = results[i]['COUNT(rel)'];

            if (answer.answername === other.answername) {
                continue;
            } else if (follows) {
                following.push(other);
            } else {
                others.push(other);
            }
        }

        callback(null, following, others);
    });
};

// Static methods:

Answer.get = function (answername, callback) {
    var query = [
        'MATCH (answer:Answer {answername: {answername}})',
        'RETURN answer',
    ].join('\n')

    var params = {
        answername: answername,
    };

    db.cypher({
        query: query,
        params: params,
    }, function (err, results) {
        if (err) return callback(err);
        if (!results.length) {
            err = new Error('No such answer with answername: ' + answername);
            return callback(err);
        }
        var answer = new Answer(results[0]['answer']);
        callback(null, answer);
    });
};

Answer.getAll = function (callback) {
    var query = [
        'MATCH (answer:Answer)',
        'RETURN answer',
    ].join('\n');

    db.cypher({
        query: query,
    }, function (err, results) {
        if (err) return callback(err);
        var answers = results.map(function (result) {
            return new Answer(result['answer']);
        });
        callback(null, answers);
    });
};

// Creates the answer and persists (saves) it to the db, incl. indexing it:
Answer.create = function (props, callback) {
    var query = [
        'CREATE (answer:Answer {props})',
        'RETURN answer',
    ].join('\n');

    var params = {
        props: validate(props)
    };

    db.cypher({
        query: query,
        params: params,
    }, function (err, results) {
        if (isConstraintViolation(err)) {
            // TODO: This assumes answername is the only relevant constraint.
            // We could parse the constraint property out of the error message,
            // but it'd be nicer if Neo4j returned this data semantically.
            // Alternately, we could tweak our query to explicitly check first
            // whether the answername is taken or not.
            err = new errors.ValidationError(
                'The answername ‘' + props.answername + '’ is taken.');
        }
        if (err) return callback(err);
        var answer = new Answer(results[0]['answer']);
        callback(null, answer);
    });
};

// Static initialization:

// Register our unique answername constraint.
// TODO: This is done async'ly (fire and forget) here for simplicity,
// but this would be better as a formal schema migration script or similar.
db.createConstraint({
    label: 'Answer',
    property: 'answername',
}, function (err, constraint) {
    if (err) throw err;     // Failing fast for now, by crash the application.
    if (constraint) {
        console.log('(Registered unique answernames constraint.)');
    } else {
        // Constraint already present; no need to log anything.
    }
})
