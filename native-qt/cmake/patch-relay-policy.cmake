# The pinned libdatachannel Relay policy only filters advertised candidates.
# Enforce it when libjuice builds pairs as well, so an ICE-lite WHIP server's
# host candidate remains usable THROUGH TURN without allowing a direct pair.
# Local MPL-2.0 modification; all source changes are reproduced below.
function(game_capture_patch_relay_source path original patched before1 after1 before2 after2)
    file(READ "${path}" source)
    string(REPLACE "\r\n" "\n" source "${source}")
    string(SHA256 digest "${source}")
    if(digest STREQUAL patched)
        return()
    endif()
    if(NOT digest STREQUAL original)
        message(FATAL_ERROR "Relay-only patch source changed: ${path}; review the pinned dependency")
    endif()
    string(REPLACE "${before1}" "${after1}" source "${source}")
    if(NOT before2 STREQUAL "")
        string(REPLACE "${before2}" "${after2}" source "${source}")
    endif()
    string(SHA256 digest "${source}")
    if(NOT digest STREQUAL patched)
        message(FATAL_ERROR "Relay-only patch did not produce expected source: ${path}")
    endif()
    file(WRITE "${path}" "${source}")
endfunction()

function(game_capture_patch_relay_policy source_dir)
    game_capture_patch_relay_source("${source_dir}/deps/libjuice/include/juice/juice.h"
        "eb53b351bd3ae21ce9046daab3cd2e66b8b7bd7d329ed0c2a338c1b3d0dc2e2a" "6622f806120b85e1468de219f1e75ae4e5fde25212db018f6eaac7ed9f2b82c7"
        [=[	void *user_ptr;

} juice_config_t;]=] [=[	void *user_ptr;

	// Game Capture: enforce relay policy on candidate pairs, not just signaling.
	int relay_only;

} juice_config_t;]=]
        "" ""
    )
    game_capture_patch_relay_source("${source_dir}/deps/libjuice/src/agent.c"
        "176ef9c3256ebc4e8f46068cb0f7e64e41f841129219db7689342a9c2e03fd6e" "ad522874140c6652b6b364df61510ebf52efa1e30dfd93db6693fab8b96647a4"
        [=[	agent->config.concurrency_mode = config->concurrency_mode;]=] [=[	agent->config.concurrency_mode = config->concurrency_mode;
	agent->config.relay_only = config->relay_only;]=]
        [=[ice_candidate_t *remote) {
	ice_candidate_pair_t pair;]=] [=[ice_candidate_t *remote) {
	// A host/reflexive pair must never bypass an explicit relay-only policy.
	if (agent->config.relay_only && (!local || local->type != ICE_CANDIDATE_TYPE_RELAYED))
		return 0;
	ice_candidate_pair_t pair;]=]
    )
    game_capture_patch_relay_source("${source_dir}/src/impl/icetransport.cpp"
        "effc78d46f79768712d2705d81d397ad97155a684ffec2657af01bcb075496cd" "0ffab573e21b1bf099c87428d81b2f2c58d3565a315cc9f0a96653451ed0f567"
        [=[	juice_config_t jconfig = {};]=] [=[	juice_config_t jconfig = {};
	jconfig.relay_only = config.iceTransportPolicy == TransportPolicy::Relay;]=]
        "" ""
    )
endfunction()
