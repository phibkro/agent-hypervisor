/** TextMate grammar for Context Mapper Language (CML), used by Shiki via rehypeCodeOptions.langs. */
export const cmlGrammar = {
  "name": "cml",
  "displayName": "Context Mapper (CML)",
  "scopeName": "source.cml",
  "aliases": [
    "contextmapper"
  ],
  "patterns": [
    {
      "include": "#comments"
    },
    {
      "include": "#strings"
    },
    {
      "include": "#relationship-roles"
    },
    {
      "include": "#declarations"
    },
    {
      "include": "#keywords"
    },
    {
      "include": "#constants"
    },
    {
      "include": "#operators"
    },
    {
      "include": "#types"
    }
  ],
  "repository": {
    "comments": {
      "patterns": [
        {
          "name": "comment.block.cml",
          "begin": "/\\*",
          "end": "\\*/"
        },
        {
          "name": "comment.line.double-slash.cml",
          "match": "//.*$"
        },
        {
          "name": "comment.line.double-dash.cml",
          "match": "--.*$"
        }
      ]
    },
    "strings": {
      "name": "string.quoted.double.cml",
      "begin": "\"",
      "end": "\"",
      "patterns": [
        {
          "name": "constant.character.escape.cml",
          "match": "\\\\."
        }
      ]
    },
    "relationship-roles": {
      "comment": "[U,OHS,PL] -> [D,ACL] and friends",
      "match": "\\[\\s*((?:U|D|S|C|P|SK|OHS|PL|ACL|CF)(?:\\s*,\\s*(?:U|D|S|C|P|SK|OHS|PL|ACL|CF))*)\\s*\\]",
      "captures": {
        "1": {
          "name": "entity.other.attribute-name.role.cml"
        }
      }
    },
    "declarations": {
      "patterns": [
        {
          "match": "\\b(ContextMap|BoundedContext|Domain|Subdomain|Aggregate|Entity|ValueObject|DomainEvent|CommandEvent|Command|Event|Service|Application|Flow|Coordination|UserStory|UseCase|Stakeholders|ValueRegister|enum|Module)\\s+([A-Za-z_][A-Za-z0-9_]*)",
          "captures": {
            "1": {
              "name": "keyword.declaration.cml"
            },
            "2": {
              "name": "entity.name.type.cml"
            }
          }
        }
      ]
    },
    "keywords": {
      "patterns": [
        {
          "name": "keyword.control.cml",
          "match": "\\b(contains|implements|realizes|refines|supports|type|state|domainVisionStatement|responsibilities|implementationTechnology|knowledgeLevel|exposedAggregates|downstreamRights|owner|aggregateRoot|aggregateLifecycle|key|delegates to|emits event|triggers command|initiated by|command|event|operation|write|read-only)\\b"
        },
        {
          "name": "keyword.other.story.cml",
          "match": "\\b(As an?|I want to|so that|and that|accepting that|is|are|promoted|harmed|reduced|with its|with their|for|in|to|a|an|the)\\b"
        }
      ]
    },
    "constants": {
      "name": "constant.language.cml",
      "match": "\\b(SYSTEM_LANDSCAPE|ORGANIZATIONAL|AS_IS|TO_BE|CORE_DOMAIN|SUPPORTING_DOMAIN|GENERIC_SUBDOMAIN|FEATURE|APPLICATION|SYSTEM|TEAM|CONCRETE|META|VETO_RIGHT|INFLUENCER|OPINION_LEADER|[A-Z][A-Z0-9_]{2,})\\b"
    },
    "operators": {
      "name": "keyword.operator.cml",
      "match": "(<->|->|<-|\\bX\\b|\\+|=)"
    },
    "types": {
      "patterns": [
        {
          "name": "support.type.primitive.cml",
          "match": "\\b(String|int|long|boolean|double|float|Date|BigDecimal|List|Set)\\b"
        },
        {
          "name": "variable.parameter.reference.cml",
          "match": "@[A-Za-z_][A-Za-z0-9_]*"
        },
        {
          "name": "entity.name.type.reference.cml",
          "match": "\\b[A-Z][A-Za-z0-9_]*\\b"
        }
      ]
    }
  }
} as const;
